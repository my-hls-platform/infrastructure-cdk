import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as event_sources from 'aws-cdk-lib/aws-lambda-event-sources'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'

export class InfrastructureCdkStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props)

		const rawBucket = new s3.Bucket(this, 'RawVideoBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			eventBridgeEnabled: true,
			cors: [
				{
					allowedMethods: [
						s3.HttpMethods.GET,
						s3.HttpMethods.PUT,
						s3.HttpMethods.POST,
						s3.HttpMethods.HEAD,
					],
					allowedOrigins: ['*'],
					allowedHeaders: ['*'],
				},
			],
		})

		const processedBucket = new s3.Bucket(this, 'ProcessedVideoBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		})

		const distribution = new cloudfront.Distribution(this, 'VideoDistribution', {
			defaultBehavior: {
				origin: S3BucketOrigin.withOriginAccessControl(processedBucket),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
				cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
			},
		})

		const dlq = new sqs.Queue(this, 'TranscoderDLQ', {
			retentionPeriod: cdk.Duration.days(14),
		})

		const transcoderQueue = new sqs.Queue(this, 'TranscoderQueue', {
			visibilityTimeout: cdk.Duration.minutes(15),
			deadLetterQueue: {
				queue: dlq,
				maxReceiveCount: 3,
			},
		})

		const s3UploadRule = new events.Rule(this, 'S3UploadRule', {
			eventPattern: {
				source: ['aws.s3'],
				detailType: ['Object Created'],
				detail: {
					bucket: {
						name: [rawBucket.bucketName],
					},
				},
			},
		})
		s3UploadRule.addTarget(new targets.SqsQueue(transcoderQueue))

		const transcoderLambda = new lambda.Function(this, 'TranscoderLambda', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("Event received from SQS:", JSON.stringify(event, null, 2));
          return { statusCode: 200, body: 'Dummy Lambda executed successfully!' };
        };
      `),
			timeout: cdk.Duration.minutes(15),
			memorySize: 2048,
		})

		rawBucket.grantWrite(transcoderLambda)
		processedBucket.grantWrite(transcoderLambda)
		transcoderLambda.addEventSource(
			new event_sources.SqsEventSource(transcoderQueue, {
				batchSize: 1,
			}),
		)

		const aiQueue = new sqs.Queue(this, 'AiAnalyzerQueue', {
			visibilityTimeout: cdk.Duration.minutes(15),
		})

		const aiTriggerRule = new events.Rule(this, 'AiTriggerRule', {
			eventPattern: {
				source: ['hls-platform.transcoder'],
				detailType: ['Video.Transcoded'],
			},
		})
		aiTriggerRule.addTarget(new targets.SqsQueue(aiQueue))

		const aiLambda = new lambda.Function(this, 'AiAnalyzerLambda', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => {}'),
			timeout: cdk.Duration.minutes(1),
			environment: {
				CLOUDFRONT_URL: `https://${distribution.distributionDomainName}`,
			},
		})

		aiLambda.addToRolePolicy(
			new cdk.aws_iam.PolicyStatement({
				actions: ['bedrock:InvokeModel'],
				resources: [
					'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0',
				],
			}),
		)

		aiLambda.addToRolePolicy(
			new cdk.aws_iam.PolicyStatement({
				actions: ['events:PutEvents'],
				resources: ['*'],
			}),
		)

		aiLambda.addEventSource(
			new event_sources.SqsEventSource(aiQueue, {
				batchSize: 1,
			}),
		)

		const statsTable = new cdk.aws_dynamodb.Table(this, 'PlatformStats', {
			partitionKey: { name: 'pk', type: cdk.aws_dynamodb.AttributeType.STRING },
			sortKey: { name: 'sk', type: cdk.aws_dynamodb.AttributeType.STRING },
			billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		})

		const cronLambda = new lambda.Function(this, 'CronJobsLambda', {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => {}'),
			timeout: cdk.Duration.minutes(5),
			environment: {
				STATS_TABLE_NAME: statsTable.tableName,
				RAW_BUCKET_NAME: rawBucket.bucketName,
				PROCESSED_BUCKET_NAME: processedBucket.bucketName,
			},
		})

		statsTable.grantWriteData(cronLambda)
		rawBucket.grantReadWrite(cronLambda)
		processedBucket.grantReadWrite(cronLambda)

		const cronRule = new events.Rule(this, 'DailyCleanupRule', {
			schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
		})

		cronRule.addTarget(new targets.LambdaFunction(cronLambda))

		const frontendBucket = new s3.Bucket(this, 'FrontendHostingBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
		})

		const frontendDistribution = new cloudfront.Distribution(
			this,
			'FrontendDistribution',
			{
				defaultBehavior: {
					origin: S3BucketOrigin.withOriginAccessControl(frontendBucket),
					viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				},
				defaultRootObject: 'index.html',
				errorResponses: [
					{
						httpStatus: 404,
						responseHttpStatus: 200,
						responsePagePath: '/index.html',
					},
					{
						httpStatus: 403,
						responseHttpStatus: 200,
						responsePagePath: '/index.html',
					},
				],
			},
		)

		const vpc = new ec2.Vpc(this, 'HlsVpc', {
			maxAzs: 2,
			natGateways: 1,
		})

		const dbInstance = new rds.DatabaseInstance(this, 'CoreApiDb', {
			engine: rds.DatabaseInstanceEngine.mysql({
				version: rds.MysqlEngineVersion.VER_8_0,
			}),
			vpc,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
			databaseName: 'hls_platform',
			credentials: rds.Credentials.fromGeneratedSecret('admin'),
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			deletionProtection: false,
		})

		const apiRepo = new ecr.Repository(this, 'CoreApiRepo', {
			repositoryName: 'hls-core-api-repo',
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			emptyOnDelete: true,
		})

		const cluster = new ecs.Cluster(this, 'CoreApiCluster', { vpc })

		const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
			this,
			'CoreApiService',
			{
				cluster,
				cpu: 256,
				memoryLimitMiB: 512,
				circuitBreaker: { rollback: true },
				taskImageOptions: {
					image: ecs.ContainerImage.fromEcrRepository(apiRepo, 'latest'),
					containerPort: 3001,
					environment: {
						PORT: '3001',
						DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/dummy',
						
					},
				},
				publicLoadBalancer: true,
			},
		)

		dbInstance.connections.allowFrom(
			fargateService.service,
			ec2.Port.tcp(3306),
			'Allow ECS to DB',
		)

		rawBucket.grantReadWrite(fargateService.taskDefinition.taskRole)
		fargateService.taskDefinition.taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ['events:PutEvents'],
				resources: ['*'],
			}),
		)

		const backendDistribution = new cloudfront.Distribution(this, 'BackendDistribution', {
			defaultBehavior: {
				origin: new cloudfront_origins.HttpOrigin(
					fargateService.loadBalancer.loadBalancerDnsName,
					{
						protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
					},
				),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
				cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
				originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
			},
		})

		new cdk.CfnOutput(this, 'DatabaseSecretArn', {
			value: dbInstance.secret?.secretArn || '',
		})

		new cdk.CfnOutput(this, 'FrontendBucketNameOutput', {
			value: frontendBucket.bucketName,
		})
		new cdk.CfnOutput(this, 'FrontendCloudFrontIdOutput', {
			value: frontendDistribution.distributionId,
		})
		new cdk.CfnOutput(this, 'FrontendWebsiteUrl', {
			value: `https://${frontendDistribution.distributionDomainName}`,
		})

		new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName })
		new cdk.CfnOutput(this, 'ProcessedBucketName', { value: processedBucket.bucketName })
		new cdk.CfnOutput(this, 'CloudFrontUrl', {
			value: `https://${distribution.distributionDomainName}`,
		})
		new cdk.CfnOutput(this, 'TranscoderLambdaName', {
			value: transcoderLambda.functionName,
		})
		new cdk.CfnOutput(this, 'AiAnalyzerLambdaName', {
			value: aiLambda.functionName,
		})
		new cdk.CfnOutput(this, 'StatsTableName', { value: statsTable.tableName })
		new cdk.CfnOutput(this, 'CronLambdaName', { value: cronLambda.functionName })

		new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName })
		new cdk.CfnOutput(this, 'EcsServiceName', {
			value: fargateService.service.serviceName,
		})
		new cdk.CfnOutput(this, 'BackendHttpsUrl', {
			value: `https://${backendDistribution.distributionDomainName}`,
		})
	}
}

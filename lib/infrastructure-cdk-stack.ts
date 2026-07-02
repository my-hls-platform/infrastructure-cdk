import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as event_sources from 'aws-cdk-lib/aws-lambda-event-sources'
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
	}
}

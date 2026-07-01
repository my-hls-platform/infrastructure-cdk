import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'

export class InfrastructureCdkStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props)

		const rawBucket = new s3.Bucket(this, 'RawVideoBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
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
				origin: new origins.S3Origin(processedBucket),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
				cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
			},
		})

		new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName })
		new cdk.CfnOutput(this, 'ProcessedBucketName', { value: processedBucket.bucketName })
		new cdk.CfnOutput(this, 'CloudFrontUrl', {
			value: `https://${distribution.distributionDomainName}`,
		})
	}
}

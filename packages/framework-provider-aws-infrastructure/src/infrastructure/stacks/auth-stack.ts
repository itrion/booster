import { BoosterConfig } from '@boostercloud/framework-types'
import { CfnOutput, RemovalPolicy, Stack } from '@aws-cdk/core'
import { AuthFlow, CfnUserPool, CfnUserPoolDomain, UserPoolAttribute, UserPoolClient } from '@aws-cdk/aws-cognito'
import { Code, Function } from '@aws-cdk/aws-lambda'
import * as params from '../params'
import { APIs } from '../params'
import { Effect, IRole, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam'
import { AwsIntegration, PassthroughBehavior } from '@aws-cdk/aws-apigateway'
import { CognitoTemplates } from './api-stack-velocity-templates'

export class AuthStack {
  public constructor(
    private readonly config: BoosterConfig,
    private readonly stack: Stack,
    private readonly apis: APIs
  ) {}

  public build(): void {
    if (this.config.thereAreRoles) {
      const userPool = this.buildUserPool()
      this.buildUserPoolClient(userPool)
      this.buildAuthAPI(userPool)
    }
  }

  private buildUserPool(): CfnUserPool {
    const localPreSignUpID = 'pre-sign-up-validator'
    const preSignUpLambda = new Function(this.stack, localPreSignUpID, {
      ...params.lambda(this.config, this.stack, this.apis),
      functionName: this.config.resourceNames.applicationStack + '-' + localPreSignUpID,
      handler: this.config.preSignUpHandler,
      code: Code.fromAsset(this.config.userProjectRootPath),
    })

    const localUserPoolID = 'user-pool'
    const externalId = 'external'
    const cognitoSNSMessageRole = this.buildCognitoRoleToSendSNSMessages()

    const userPool = new CfnUserPool(this.stack, localUserPoolID, {
      userPoolName: this.config.resourceNames.applicationStack + '-' + localUserPoolID,
      autoVerifiedAttributes: [UserPoolAttribute.EMAIL, UserPoolAttribute.PHONE_NUMBER],
      schema: [
        {
          attributeDataType: 'String',
          mutable: true,
          name: 'role',
        },
      ],
      usernameAttributes: [UserPoolAttribute.EMAIL, UserPoolAttribute.PHONE_NUMBER],
      verificationMessageTemplate: {
        defaultEmailOption: 'CONFIRM_WITH_LINK',
      },
      smsConfiguration: {
        externalId: this.config.resourceNames.applicationStack + '-' + externalId,
        snsCallerArn: cognitoSNSMessageRole.roleArn,
      },
      lambdaConfig: {
        preSignUp: preSignUpLambda.functionArn,
      },
    })

    preSignUpLambda.addPermission(localPreSignUpID + '-user-pool-permission', {
      principal: new ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: userPool.attrArn,
    })

    const localUserPoolDomainID = 'user-pool-domain'
    new CfnUserPoolDomain(this.stack, localUserPoolDomainID, {
      userPoolId: userPool.ref,
      domain: this.config.resourceNames.applicationStack,
    }).applyRemovalPolicy(RemovalPolicy.DESTROY)

    return userPool
  }

  private buildUserPoolClient(userPool: CfnUserPool): void {
    // Usually, you have multiple clients: one for your WebApp, another for your MobileApp, etc.
    // We could allow defining how many clients the user wants. So far we just create one.
    const localUserPoolClientID = 'user-pool-client'
    const userPoolClient = new UserPoolClient(this.stack, localUserPoolClientID, {
      userPoolClientName: this.config.resourceNames.applicationStack + '-' + localUserPoolClientID,
      userPool: {
        node: userPool.node,
        stack: this.stack,
        userPoolArn: userPool.attrArn,
        userPoolId: userPool.ref,
        userPoolProviderName: userPool.attrProviderName,
        userPoolProviderUrl: userPool.attrProviderUrl,
      },
      enabledAuthFlows: [AuthFlow.USER_PASSWORD],
    })

    new CfnOutput(this.stack, 'clientID', {
      value: userPoolClient.userPoolClientId,
      description: 'Needed for the auth API. This ID must be included in that API under the name "clientID"',
    })
  }

  private buildAuthAPI(userPool: CfnUserPool): void {
    const cognitoIntegrationRole = this.buildCognitoIntegrationRole(userPool)

    const authResource = this.apis.restAPI.root.addResource('auth')
    const methodOptions = {
      methodResponses: [
        {
          statusCode: '200',
        },
        {
          statusCode: '400',
        },
        {
          statusCode: '500',
        },
      ],
    }
    const signUpResource = authResource.addResource('sign-up')
    signUpResource.addMethod('POST', this.buildSignUpIntegration(cognitoIntegrationRole), methodOptions)
    signUpResource
      .addResource('confirm')
      .addMethod('POST', this.buildConfirmSignUpIntegration(cognitoIntegrationRole), methodOptions)
    authResource
      .addResource('sign-in')
      .addMethod('POST', this.buildSignInIntegration(cognitoIntegrationRole), methodOptions)
    authResource
      .addResource('refresh-token')
      .addMethod('POST', this.buildRefreshTokenIntegration(cognitoIntegrationRole), methodOptions)
    authResource
      .addResource('sign-out')
      .addMethod('POST', this.buildSignOutIntegration(cognitoIntegrationRole), methodOptions)
  }

  private buildCognitoIntegrationRole(userPool: CfnUserPool): Role {
    return new Role(this.stack, 'cognito-integration-role', {
      assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        'cognito-sign': new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['cognito-idp:SignUp', 'cognito-idp:InitiateAuth', 'cognito-idp:GlobalSignOut'],
              resources: [userPool.attrArn],
            }),
          ],
        }),
      },
    })
  }

  private buildCognitoRoleToSendSNSMessages(): Role {
    return new Role(this.stack, 'cognito-sns-messages-role', {
      assumedBy: new ServicePrincipal('cognito-idp.amazonaws.com'),
      description:
        'An IAM Role to allow Cognito to send SNS messages in order for users to be register themselves through their phones',
      inlinePolicies: {
        'cognito-sns-managed-policy': new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['sns:publish'],
              resources: ['*'],
            }),
          ],
        }),
      },
    })
  }

  private buildSignOutIntegration(withRole: IRole): AwsIntegration {
    return this.buildCognitoIntegration('GlobalSignOut', withRole, {
      requestTemplate: CognitoTemplates.signOut.request,
      responseTemplate: CognitoTemplates.signOut.response,
    })
  }

  private buildSignUpIntegration(withRole: IRole): AwsIntegration {
    return this.buildCognitoIntegration('SignUp', withRole, {
      requestTemplate: CognitoTemplates.signUp.request,
      responseTemplate: CognitoTemplates.signUp.response,
    })
  }

  private buildConfirmSignUpIntegration(withRole: IRole): AwsIntegration {
    return this.buildCognitoIntegration('ConfirmSignUp', withRole, {
      requestTemplate: CognitoTemplates.confirmSignUp.request,
      responseTemplate: CognitoTemplates.confirmSignUp.response,
    })
  }

  private buildSignInIntegration(withRole: IRole): AwsIntegration {
    return this.buildCognitoIntegration('InitiateAuth', withRole, {
      requestTemplate: CognitoTemplates.signIn.request,
      responseTemplate: CognitoTemplates.signIn.response,
    })
  }

  private buildRefreshTokenIntegration(withRole: IRole): AwsIntegration {
    return this.buildCognitoIntegration('InitiateAuth', withRole, {
      requestTemplate: CognitoTemplates.refreshToken.request,
      responseTemplate: CognitoTemplates.refreshToken.response,
    })
  }

  private buildCognitoIntegration(
    forAction: CognitoAuthActions,
    withRole: IRole,
    templates: { requestTemplate: string; responseTemplate: string }
  ): AwsIntegration {
    return new AwsIntegration({
      service: 'cognito-idp',
      action: forAction,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: withRole,
        passthroughBehavior: PassthroughBehavior.NEVER,
        integrationResponses: [
          {
            selectionPattern: '5\\d\\d',
            statusCode: '500',
          },
          {
            selectionPattern: '4\\d\\d',
            statusCode: '400',
          },
          {
            selectionPattern: '2\\d\\d',
            statusCode: '200',
            responseTemplates: {
              'application/json': templates.responseTemplate,
            },
          },
        ],
        requestTemplates: {
          'application/json': templates.requestTemplate,
        },
      },
    })
  }
}

// Note: InitiateAuth is used for sign-in and refresh-token
type CognitoAuthActions = 'InitiateAuth' | 'SignUp' | 'ConfirmSignUp' | 'GlobalSignOut'

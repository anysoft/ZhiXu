export type ProviderFieldType =
  | 'text'
  | 'password'
  | 'url'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'keyValue';
export interface ProviderField {
  name: string;
  labelKey: string;
  descriptionKey?: string;
  placeholderKey?: string;
  type: ProviderFieldType;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{ value: string | number; labelKey: string }>;
  sensitive?: boolean;
  advanced?: boolean;
  visibleWhen?: { field: string; equals: string | number | boolean };
  wire?: boolean;
  min?: number;
  max?: number;
}
export interface ProviderSchema {
  id: string;
  labelKey: string;
  descriptionKey: string;
  fields: ProviderField[];
  requiredFields: string[];
  wireFields: string[];
}
export type ProviderConfig = Record<string, unknown>;
export interface ProviderValidationIssue {
  field: string;
  messageKey: string;
}

// Field names and defaults follow notificationConfig.ts and notify.ts, not the old UI map.
export const providerSchemas: Record<string, ProviderSchema> = {
  WEBHOOK: {
    id: 'WEBHOOK',
    labelKey: 'notifications.provider.WEBHOOK',
    descriptionKey: 'notifications.description.WEBHOOK',
    fields: [
      {
        name: 'url',
        labelKey: 'notifications.field.url',
        type: 'url',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.url',
      },
      {
        name: 'authorization',
        labelKey: 'notifications.field.authorization',
        type: 'password',
        sensitive: true,
        descriptionKey: 'notifications.help.authorization',
      },
    ],
    requiredFields: ['url'],
    wireFields: ['url', 'authorization'],
  },
  gotify: {
    id: 'gotify',
    labelKey: 'notifications.provider.gotify',
    descriptionKey: 'notifications.description.gotify',
    fields: [
      {
        name: 'gotifyUrl',
        labelKey: 'notifications.field.gotifyUrl',
        type: 'url',
        sensitive: false,
        required: true,
      },
      {
        name: 'gotifyToken',
        labelKey: 'notifications.field.gotifyToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'gotifyPriority',
        labelKey: 'notifications.field.gotifyPriority',
        type: 'number',
        sensitive: false,
        defaultValue: 1,
        advanced: true,
        min: 0,
      },
    ],
    requiredFields: ['gotifyUrl', 'gotifyToken'],
    wireFields: ['gotifyUrl', 'gotifyToken', 'gotifyPriority'],
  },
  goCqHttpBot: {
    id: 'goCqHttpBot',
    labelKey: 'notifications.provider.goCqHttpBot',
    descriptionKey: 'notifications.description.goCqHttpBot',
    fields: [
      {
        name: 'goCqHttpBotUrl',
        labelKey: 'notifications.field.goCqHttpBotUrl',
        type: 'url',
        sensitive: false,
        required: true,
      },
      {
        name: 'goCqHttpBotQq',
        labelKey: 'notifications.field.goCqHttpBotQq',
        type: 'text',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.goCqHttpBotQq',
      },
      {
        name: 'goCqHttpBotToken',
        labelKey: 'notifications.field.goCqHttpBotToken',
        type: 'password',
        sensitive: true,
        advanced: true,
      },
    ],
    requiredFields: ['goCqHttpBotUrl', 'goCqHttpBotQq'],
    wireFields: ['goCqHttpBotUrl', 'goCqHttpBotQq', 'goCqHttpBotToken'],
  },
  serverChan: {
    id: 'serverChan',
    labelKey: 'notifications.provider.serverChan',
    descriptionKey: 'notifications.description.serverChan',
    fields: [
      {
        name: 'serverChanKey',
        labelKey: 'notifications.field.serverChanKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
    ],
    requiredFields: ['serverChanKey'],
    wireFields: ['serverChanKey'],
  },
  pushDeer: {
    id: 'pushDeer',
    labelKey: 'notifications.provider.pushDeer',
    descriptionKey: 'notifications.description.pushDeer',
    fields: [
      {
        name: 'pushDeerKey',
        labelKey: 'notifications.field.pushDeerKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'pushDeerUrl',
        labelKey: 'notifications.field.pushDeerUrl',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://api2.pushdeer.com/message/push',
        advanced: true,
      },
    ],
    requiredFields: ['pushDeerKey'],
    wireFields: ['pushDeerKey', 'pushDeerUrl'],
  },
  chat: {
    id: 'chat',
    labelKey: 'notifications.provider.chat',
    descriptionKey: 'notifications.description.chat',
    fields: [
      {
        name: 'synologyChatUrl',
        labelKey: 'notifications.field.synologyChatUrl',
        type: 'url',
        sensitive: false,
        required: true,
      },
    ],
    requiredFields: ['synologyChatUrl'],
    wireFields: ['synologyChatUrl'],
  },
  bark: {
    id: 'bark',
    labelKey: 'notifications.provider.bark',
    descriptionKey: 'notifications.description.bark',
    fields: [
      {
        name: 'barkPush',
        labelKey: 'notifications.field.barkPush',
        type: 'text',
        sensitive: false,
        required: true,
      },
      {
        name: 'barkIcon',
        labelKey: 'notifications.field.barkIcon',
        type: 'url',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'barkSound',
        labelKey: 'notifications.field.barkSound',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'barkGroup',
        labelKey: 'notifications.field.barkGroup',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'barkLevel',
        labelKey: 'notifications.field.barkLevel',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'barkUrl',
        labelKey: 'notifications.field.barkUrl',
        type: 'url',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'barkArchive',
        labelKey: 'notifications.field.barkArchive',
        type: 'select',
        sensitive: false,
        advanced: true,
        options: [
          {
            value: '0',
            labelKey: 'notifications.option.barkArchive.0',
          },
          {
            value: '1',
            labelKey: 'notifications.option.barkArchive.1',
          },
        ],
      },
    ],
    requiredFields: ['barkPush'],
    wireFields: [
      'barkPush',
      'barkIcon',
      'barkSound',
      'barkGroup',
      'barkLevel',
      'barkUrl',
      'barkArchive',
    ],
  },
  telegramBot: {
    id: 'telegramBot',
    labelKey: 'notifications.provider.telegramBot',
    descriptionKey: 'notifications.description.telegramBot',
    fields: [
      {
        name: 'telegramBotToken',
        labelKey: 'notifications.field.telegramBotToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'telegramBotUserId',
        labelKey: 'notifications.field.telegramBotUserId',
        type: 'text',
        sensitive: false,
        required: true,
      },
      {
        name: 'telegramBotApiHost',
        labelKey: 'notifications.field.telegramBotApiHost',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://api.telegram.org',
      },
      {
        name: 'telegramBotProxyHost',
        labelKey: 'notifications.field.telegramBotProxyHost',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'telegramBotProxyPort',
        labelKey: 'notifications.field.telegramBotProxyPort',
        type: 'text',
        sensitive: false,
        advanced: true,
        descriptionKey: 'notifications.help.telegramBotProxyPort',
      },
      {
        name: 'telegramBotProxyAuth',
        labelKey: 'notifications.field.telegramBotProxyAuth',
        type: 'password',
        sensitive: true,
        advanced: true,
        descriptionKey: 'notifications.help.telegramBotProxyAuth',
      },
    ],
    requiredFields: ['telegramBotToken', 'telegramBotUserId'],
    wireFields: [
      'telegramBotToken',
      'telegramBotUserId',
      'telegramBotApiHost',
      'telegramBotProxyHost',
      'telegramBotProxyPort',
      'telegramBotProxyAuth',
    ],
  },
  dingtalkBot: {
    id: 'dingtalkBot',
    labelKey: 'notifications.provider.dingtalkBot',
    descriptionKey: 'notifications.description.dingtalkBot',
    fields: [
      {
        name: 'dingtalkBotToken',
        labelKey: 'notifications.field.dingtalkBotToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'dingtalkBotSecret',
        labelKey: 'notifications.field.dingtalkBotSecret',
        type: 'password',
        sensitive: true,
        descriptionKey: 'notifications.help.dingtalkBotSecret',
      },
    ],
    requiredFields: ['dingtalkBotToken'],
    wireFields: ['dingtalkBotToken', 'dingtalkBotSecret'],
  },
  weWorkBot: {
    id: 'weWorkBot',
    labelKey: 'notifications.provider.weWorkBot',
    descriptionKey: 'notifications.description.weWorkBot',
    fields: [
      {
        name: 'weWorkBotKey',
        labelKey: 'notifications.field.weWorkBotKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'weWorkOrigin',
        labelKey: 'notifications.field.weWorkOrigin',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://qyapi.weixin.qq.com',
        advanced: true,
      },
    ],
    requiredFields: ['weWorkBotKey'],
    wireFields: ['weWorkBotKey', 'weWorkOrigin'],
  },
  weWorkApp: {
    id: 'weWorkApp',
    labelKey: 'notifications.provider.weWorkApp',
    descriptionKey: 'notifications.description.weWorkApp',
    fields: [
      {
        name: 'corpId',
        labelKey: 'notifications.field.corpId',
        type: 'text',
        sensitive: false,
        required: true,
        wire: false,
      },
      {
        name: 'corpSecret',
        labelKey: 'notifications.field.corpSecret',
        type: 'password',
        sensitive: true,
        required: true,
        wire: false,
      },
      {
        name: 'toUser',
        labelKey: 'notifications.field.toUser',
        type: 'text',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.toUser',
        wire: false,
      },
      {
        name: 'agentId',
        labelKey: 'notifications.field.agentId',
        type: 'text',
        sensitive: false,
        required: true,
        wire: false,
      },
      {
        name: 'messageType',
        labelKey: 'notifications.field.messageType',
        type: 'select',
        sensitive: false,
        required: true,
        defaultValue: 'text',
        wire: false,
        options: [
          {
            value: 'text',
            labelKey: 'notifications.option.messageType.0',
          },
          {
            value: 'textcard',
            labelKey: 'notifications.option.messageType.1',
          },
          {
            value: 'mpnews',
            labelKey: 'notifications.option.messageType.2',
          },
        ],
      },
      {
        name: 'thumbMediaId',
        labelKey: 'notifications.field.thumbMediaId',
        type: 'text',
        sensitive: false,
        required: true,
        visibleWhen: {
          field: 'messageType',
          equals: 'mpnews',
        },
        descriptionKey: 'notifications.help.thumbMediaId',
        wire: false,
      },
      {
        name: 'weWorkOrigin',
        labelKey: 'notifications.field.weWorkOrigin',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://qyapi.weixin.qq.com',
        advanced: true,
      },
    ],
    requiredFields: ['weWorkAppKey'],
    wireFields: ['weWorkAppKey', 'weWorkOrigin'],
  },
  aibotk: {
    id: 'aibotk',
    labelKey: 'notifications.provider.aibotk',
    descriptionKey: 'notifications.description.aibotk',
    fields: [
      {
        name: 'aibotkKey',
        labelKey: 'notifications.field.aibotkKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'aibotkType',
        labelKey: 'notifications.field.aibotkType',
        type: 'select',
        sensitive: false,
        required: true,
        defaultValue: 'room',
        options: [
          {
            value: 'room',
            labelKey: 'notifications.option.aibotkType.0',
          },
          {
            value: 'contact',
            labelKey: 'notifications.option.aibotkType.1',
          },
        ],
      },
      {
        name: 'aibotkName',
        labelKey: 'notifications.field.aibotkName',
        type: 'text',
        sensitive: false,
        required: true,
      },
    ],
    requiredFields: ['aibotkKey', 'aibotkType', 'aibotkName'],
    wireFields: ['aibotkKey', 'aibotkType', 'aibotkName'],
  },
  iGot: {
    id: 'iGot',
    labelKey: 'notifications.provider.iGot',
    descriptionKey: 'notifications.description.iGot',
    fields: [
      {
        name: 'iGotPushKey',
        labelKey: 'notifications.field.iGotPushKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
    ],
    requiredFields: ['iGotPushKey'],
    wireFields: ['iGotPushKey'],
  },
  pushPlus: {
    id: 'pushPlus',
    labelKey: 'notifications.provider.pushPlus',
    descriptionKey: 'notifications.description.pushPlus',
    fields: [
      {
        name: 'pushPlusToken',
        labelKey: 'notifications.field.pushPlusToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'pushPlusUser',
        labelKey: 'notifications.field.pushPlusUser',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'pushPlusTemplate',
        labelKey: 'notifications.field.pushPlusTemplate',
        type: 'text',
        sensitive: false,
        defaultValue: 'html',
        advanced: true,
      },
      {
        name: 'pushplusChannel',
        labelKey: 'notifications.field.pushplusChannel',
        type: 'text',
        sensitive: false,
        defaultValue: 'wechat',
        advanced: true,
      },
      {
        name: 'pushplusWebhook',
        labelKey: 'notifications.field.pushplusWebhook',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'pushplusCallbackUrl',
        labelKey: 'notifications.field.pushplusCallbackUrl',
        type: 'url',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'pushplusTo',
        labelKey: 'notifications.field.pushplusTo',
        type: 'password',
        sensitive: true,
        advanced: true,
      },
    ],
    requiredFields: ['pushPlusToken'],
    wireFields: [
      'pushPlusToken',
      'pushPlusUser',
      'pushPlusTemplate',
      'pushplusChannel',
      'pushplusWebhook',
      'pushplusCallbackUrl',
      'pushplusTo',
    ],
  },
  wePlusBot: {
    id: 'wePlusBot',
    labelKey: 'notifications.provider.wePlusBot',
    descriptionKey: 'notifications.description.wePlusBot',
    fields: [
      {
        name: 'wePlusBotToken',
        labelKey: 'notifications.field.wePlusBotToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'wePlusBotReceiver',
        labelKey: 'notifications.field.wePlusBotReceiver',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
      {
        name: 'wePlusBotVersion',
        labelKey: 'notifications.field.wePlusBotVersion',
        type: 'select',
        sensitive: false,
        defaultValue: 'pro',
        advanced: true,
        options: [
          {
            value: 'pro',
            labelKey: 'notifications.option.wePlusBotVersion.0',
          },
          {
            value: 'personal',
            labelKey: 'notifications.option.wePlusBotVersion.1',
          },
        ],
      },
    ],
    requiredFields: ['wePlusBotToken'],
    wireFields: ['wePlusBotToken', 'wePlusBotReceiver', 'wePlusBotVersion'],
  },
  email: {
    id: 'email',
    labelKey: 'notifications.provider.email',
    descriptionKey: 'notifications.description.email',
    fields: [
      {
        name: 'emailMode',
        labelKey: 'notifications.field.emailMode',
        type: 'select',
        sensitive: false,
        required: true,
        defaultValue: 'service',
        wire: false,
        options: [
          {
            value: 'service',
            labelKey: 'notifications.option.emailMode.0',
          },
          {
            value: 'smtp',
            labelKey: 'notifications.option.emailMode.1',
          },
        ],
      },
      {
        name: 'emailService',
        labelKey: 'notifications.field.emailService',
        type: 'text',
        sensitive: false,
        required: true,
        visibleWhen: {
          field: 'emailMode',
          equals: 'service',
        },
        descriptionKey: 'notifications.help.emailService',
      },
      {
        name: 'emailHost',
        labelKey: 'notifications.field.emailHost',
        type: 'text',
        sensitive: false,
        required: true,
        visibleWhen: {
          field: 'emailMode',
          equals: 'smtp',
        },
      },
      {
        name: 'emailPort',
        labelKey: 'notifications.field.emailPort',
        type: 'number',
        sensitive: false,
        defaultValue: 587,
        visibleWhen: {
          field: 'emailMode',
          equals: 'smtp',
        },
        min: 1,
        max: 65535,
      },
      {
        name: 'emailSecure',
        labelKey: 'notifications.field.emailSecure',
        type: 'boolean',
        sensitive: false,
        defaultValue: false,
        visibleWhen: {
          field: 'emailMode',
          equals: 'smtp',
        },
        descriptionKey: 'notifications.help.emailSecure',
      },
      {
        name: 'emailUser',
        labelKey: 'notifications.field.emailUser',
        type: 'text',
        sensitive: false,
        required: true,
      },
      {
        name: 'emailPass',
        labelKey: 'notifications.field.emailPass',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'emailTo',
        labelKey: 'notifications.field.emailTo',
        type: 'text',
        sensitive: false,
        descriptionKey: 'notifications.help.emailTo',
      },
    ],
    requiredFields: ['emailUser', 'emailPass'],
    wireFields: [
      'emailService',
      'emailHost',
      'emailPort',
      'emailSecure',
      'emailUser',
      'emailPass',
      'emailTo',
    ],
  },
  pushMe: {
    id: 'pushMe',
    labelKey: 'notifications.provider.pushMe',
    descriptionKey: 'notifications.description.pushMe',
    fields: [
      {
        name: 'pushMeKey',
        labelKey: 'notifications.field.pushMeKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'pushMeUrl',
        labelKey: 'notifications.field.pushMeUrl',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://push.i-i.me/',
        advanced: true,
      },
    ],
    requiredFields: ['pushMeKey'],
    wireFields: ['pushMeKey', 'pushMeUrl'],
  },
  webhook: {
    id: 'webhook',
    labelKey: 'notifications.provider.webhook',
    descriptionKey: 'notifications.description.webhook',
    fields: [
      {
        name: 'webhookMethod',
        labelKey: 'notifications.field.webhookMethod',
        type: 'select',
        sensitive: false,
        required: true,
        defaultValue: 'GET',
        options: [
          {
            value: 'GET',
            labelKey: 'notifications.option.webhookMethod.0',
          },
          {
            value: 'POST',
            labelKey: 'notifications.option.webhookMethod.1',
          },
          {
            value: 'PUT',
            labelKey: 'notifications.option.webhookMethod.2',
          },
        ],
      },
      {
        name: 'webhookContentType',
        labelKey: 'notifications.field.webhookContentType',
        type: 'select',
        sensitive: false,
        required: true,
        defaultValue: 'application/json',
        options: [
          {
            value: 'application/json',
            labelKey: 'notifications.option.webhookContentType.0',
          },
          {
            value: 'multipart/form-data',
            labelKey: 'notifications.option.webhookContentType.1',
          },
          {
            value: 'application/x-www-form-urlencoded',
            labelKey: 'notifications.option.webhookContentType.2',
          },
          {
            value: 'text/plain',
            labelKey: 'notifications.option.webhookContentType.3',
          },
        ],
      },
      {
        name: 'webhookUrl',
        labelKey: 'notifications.field.webhookUrl',
        type: 'url',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.webhookUrl',
      },
      {
        name: 'webhookHeaders',
        labelKey: 'notifications.field.webhookHeaders',
        type: 'keyValue',
        sensitive: false,
        advanced: true,
        descriptionKey: 'notifications.help.webhookHeaders',
      },
      {
        name: 'webhookBody',
        labelKey: 'notifications.field.webhookBody',
        type: 'textarea',
        sensitive: false,
        descriptionKey: 'notifications.help.webhookBody',
      },
    ],
    requiredFields: ['webhookMethod', 'webhookContentType', 'webhookUrl'],
    wireFields: [
      'webhookMethod',
      'webhookContentType',
      'webhookUrl',
      'webhookHeaders',
      'webhookBody',
    ],
  },
  lark: {
    id: 'lark',
    labelKey: 'notifications.provider.lark',
    descriptionKey: 'notifications.description.lark',
    fields: [
      {
        name: 'larkKey',
        labelKey: 'notifications.field.larkKey',
        type: 'text',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.larkKey',
      },
      {
        name: 'larkSecret',
        labelKey: 'notifications.field.larkSecret',
        type: 'password',
        sensitive: true,
        descriptionKey: 'notifications.help.larkSecret',
      },
    ],
    requiredFields: ['larkKey'],
    wireFields: ['larkKey', 'larkSecret'],
  },
  chronocat: {
    id: 'chronocat',
    labelKey: 'notifications.provider.chronocat',
    descriptionKey: 'notifications.description.chronocat',
    fields: [
      {
        name: 'chronocatURL',
        labelKey: 'notifications.field.chronocatURL',
        type: 'url',
        sensitive: false,
        required: true,
      },
      {
        name: 'chronocatQQ',
        labelKey: 'notifications.field.chronocatQQ',
        type: 'text',
        sensitive: false,
        required: true,
        descriptionKey: 'notifications.help.chronocatQQ',
      },
      {
        name: 'chronocatToken',
        labelKey: 'notifications.field.chronocatToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
    ],
    requiredFields: ['chronocatURL', 'chronocatQQ', 'chronocatToken'],
    wireFields: ['chronocatURL', 'chronocatQQ', 'chronocatToken'],
  },
  ntfy: {
    id: 'ntfy',
    labelKey: 'notifications.provider.ntfy',
    descriptionKey: 'notifications.description.ntfy',
    fields: [
      {
        name: 'ntfyTopic',
        labelKey: 'notifications.field.ntfyTopic',
        type: 'text',
        sensitive: false,
        required: true,
      },
      {
        name: 'ntfyUrl',
        labelKey: 'notifications.field.ntfyUrl',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://ntfy.sh',
      },
      {
        name: 'ntfyAuthMode',
        labelKey: 'notifications.field.ntfyAuthMode',
        type: 'select',
        sensitive: false,
        defaultValue: 'none',
        wire: false,
        options: [
          {
            value: 'none',
            labelKey: 'notifications.option.ntfyAuthMode.0',
          },
          {
            value: 'token',
            labelKey: 'notifications.option.ntfyAuthMode.1',
          },
          {
            value: 'basic',
            labelKey: 'notifications.option.ntfyAuthMode.2',
          },
        ],
      },
      {
        name: 'ntfyToken',
        labelKey: 'notifications.field.ntfyToken',
        type: 'password',
        sensitive: true,
        required: true,
        visibleWhen: {
          field: 'ntfyAuthMode',
          equals: 'token',
        },
      },
      {
        name: 'ntfyUsername',
        labelKey: 'notifications.field.ntfyUsername',
        type: 'text',
        sensitive: false,
        required: true,
        visibleWhen: {
          field: 'ntfyAuthMode',
          equals: 'basic',
        },
      },
      {
        name: 'ntfyPassword',
        labelKey: 'notifications.field.ntfyPassword',
        type: 'password',
        sensitive: true,
        required: true,
        visibleWhen: {
          field: 'ntfyAuthMode',
          equals: 'basic',
        },
      },
      {
        name: 'ntfyPriority',
        labelKey: 'notifications.field.ntfyPriority',
        type: 'select',
        sensitive: false,
        defaultValue: '3',
        advanced: true,
        options: [
          {
            value: '1',
            labelKey: 'notifications.option.ntfyPriority.0',
          },
          {
            value: '2',
            labelKey: 'notifications.option.ntfyPriority.1',
          },
          {
            value: '3',
            labelKey: 'notifications.option.ntfyPriority.2',
          },
          {
            value: '4',
            labelKey: 'notifications.option.ntfyPriority.3',
          },
          {
            value: '5',
            labelKey: 'notifications.option.ntfyPriority.4',
          },
        ],
      },
      {
        name: 'ntfyActions',
        labelKey: 'notifications.field.ntfyActions',
        type: 'textarea',
        sensitive: false,
        advanced: true,
      },
    ],
    requiredFields: ['ntfyTopic'],
    wireFields: [
      'ntfyTopic',
      'ntfyUrl',
      'ntfyToken',
      'ntfyUsername',
      'ntfyPassword',
      'ntfyPriority',
      'ntfyActions',
    ],
  },
  wxPusherBot: {
    id: 'wxPusherBot',
    labelKey: 'notifications.provider.wxPusherBot',
    descriptionKey: 'notifications.description.wxPusherBot',
    fields: [
      {
        name: 'wxPusherBotAppToken',
        labelKey: 'notifications.field.wxPusherBotAppToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'wxPusherBotTopicIds',
        labelKey: 'notifications.field.wxPusherBotTopicIds',
        type: 'text',
        sensitive: false,
        descriptionKey: 'notifications.help.wxPusherBotTopicIds',
      },
      {
        name: 'wxPusherBotUids',
        labelKey: 'notifications.field.wxPusherBotUids',
        type: 'text',
        sensitive: false,
        descriptionKey: 'notifications.help.wxPusherBotUids',
      },
    ],
    requiredFields: ['wxPusherBotAppToken'],
    wireFields: [
      'wxPusherBotAppToken',
      'wxPusherBotTopicIds',
      'wxPusherBotUids',
    ],
  },
  wxPusherSpt: {
    id: 'wxPusherSpt',
    labelKey: 'notifications.provider.wxPusherSpt',
    descriptionKey: 'notifications.description.wxPusherSpt',
    fields: [
      {
        name: 'wxPusherSptList',
        labelKey: 'notifications.field.wxPusherSptList',
        type: 'password',
        sensitive: true,
        required: true,
        descriptionKey: 'notifications.help.wxPusherSptList',
      },
    ],
    requiredFields: ['wxPusherSptList'],
    wireFields: ['wxPusherSptList'],
  },
  openiLink: {
    id: 'openiLink',
    labelKey: 'notifications.provider.openiLink',
    descriptionKey: 'notifications.description.openiLink',
    fields: [
      {
        name: 'openiLinkAppToken',
        labelKey: 'notifications.field.openiLinkAppToken',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'openiLinkHubUrl',
        labelKey: 'notifications.field.openiLinkHubUrl',
        type: 'url',
        sensitive: false,
        defaultValue: 'https://hub.openilink.com',
        advanced: true,
      },
      {
        name: 'openiLinkContextToken',
        labelKey: 'notifications.field.openiLinkContextToken',
        type: 'password',
        sensitive: true,
        advanced: true,
      },
    ],
    requiredFields: ['openiLinkAppToken'],
    wireFields: [
      'openiLinkAppToken',
      'openiLinkHubUrl',
      'openiLinkContextToken',
    ],
  },
  wpush: {
    id: 'wpush',
    labelKey: 'notifications.provider.wpush',
    descriptionKey: 'notifications.description.wpush',
    fields: [
      {
        name: 'wpushApiKey',
        labelKey: 'notifications.field.wpushApiKey',
        type: 'password',
        sensitive: true,
        required: true,
      },
      {
        name: 'wpushChannel',
        labelKey: 'notifications.field.wpushChannel',
        type: 'text',
        sensitive: false,
        defaultValue: 'wechat',
        advanced: true,
      },
      {
        name: 'wpushTopicCode',
        labelKey: 'notifications.field.wpushTopicCode',
        type: 'text',
        sensitive: false,
        advanced: true,
      },
    ],
    requiredFields: ['wpushApiKey'],
    wireFields: ['wpushApiKey', 'wpushChannel', 'wpushTopicCode'],
  },
};

const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'type']);
const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && !value.trim());
function schemaFor(provider: string): ProviderSchema | undefined {
  return Object.prototype.hasOwnProperty.call(providerSchemas, provider)
    ? providerSchemas[provider]
    : undefined;
}
export function getProviderDefaults(provider: string): ProviderConfig {
  return Object.fromEntries(
    (schemaFor(provider)?.fields || [])
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.name, field.defaultValue]),
  );
}
export function isProviderFieldVisible(
  field: ProviderField,
  values: ProviderConfig,
): boolean {
  return (
    !field.visibleWhen ||
    values[field.visibleWhen.field] === field.visibleWhen.equals
  );
}
function safeConfig(value: unknown): value is ProviderConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    !Object.keys(value).some((key) => forbidden.has(key))
  );
}
function validUrl(value: string, httpsOnly = false): boolean {
  try {
    const url = new URL(value);
    return (
      value === value.trim() &&
      (httpsOnly
        ? url.protocol === 'https:'
        : ['http:', 'https:'].includes(url.protocol)) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function validHeaderRows(value: unknown): boolean {
  if (typeof value === 'string') {
    return value
      .split('\n')
      .every(
        (line) =>
          !line.trim() ||
          (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:\s*[^\r\n]*$/.test(line) &&
            !forbidden.has(line.slice(0, line.indexOf(':')).toLowerCase())),
      );
  }
  if (!Array.isArray(value)) return false;
  return value.every(
    (row) =>
      safeConfig(row) &&
      Object.keys(row).every((key) => ['key', 'value'].includes(key)) &&
      typeof row.key === 'string' &&
      typeof row.value === 'string' &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.key) &&
      !forbidden.has(row.key.toLowerCase()) &&
      !/[\r\n]/.test(row.value),
  );
}
export function validateProviderConfig(
  provider: string,
  input: unknown,
): ProviderValidationIssue[] {
  const schema = schemaFor(provider);
  const issues: ProviderValidationIssue[] = [];
  const issue = (field: string, name: string) =>
    issues.push({ field, messageKey: `notifications.validation.${name}` });
  if (!schema || !safeConfig(input))
    return [{ field: '', messageKey: 'notifications.validation.invalid' }];
  const values = { ...getProviderDefaults(provider), ...input };
  for (const field of schema.fields) {
    if (!isProviderFieldVisible(field, values)) continue;
    const value = values[field.name];
    if (isEmpty(value)) {
      if (field.required) issue(field.name, 'required');
      continue;
    }
    if (field.type === 'keyValue') {
      if (!validHeaderRows(value)) issue(field.name, 'headers');
      continue;
    }
    const type =
      field.type === 'number'
        ? 'number'
        : field.type === 'boolean'
        ? 'boolean'
        : 'string';
    if (typeof value !== type) {
      issue(field.name, 'type');
      continue;
    }
    if (
      field.type === 'number' &&
      (!Number.isInteger(value) ||
        !Number.isFinite(value) ||
        (field.min !== undefined && Number(value) < field.min) ||
        (field.max !== undefined && Number(value) > field.max))
    )
      issue(field.name, 'number');
    if (field.type === 'url' && !validUrl(String(value)))
      issue(field.name, 'url');
    if (
      field.options &&
      !field.options.some((option) => option.value === value)
    )
      issue(field.name, 'option');
  }
  if (provider === 'lark' || provider === 'bark') {
    const key = provider === 'lark' ? 'larkKey' : 'barkPush';
    if (
      typeof values[key] === 'string' &&
      /^https?:/i.test(String(values[key])) &&
      !validUrl(String(values[key]))
    )
      issue(key, 'url');
  }
  if (
    provider === 'email' &&
    values.emailMode === 'smtp' &&
    typeof values.emailHost === 'string' &&
    !/^[a-zA-Z0-9.:-]{1,253}$/.test(values.emailHost)
  )
    issue('emailHost', 'host');
  if (provider === 'telegramBot') {
    const host = values.telegramBotProxyHost,
      port = values.telegramBotProxyPort;
    if (
      (!isEmpty(host) || !isEmpty(port)) &&
      (isEmpty(host) ||
        typeof port !== 'string' ||
        !/^\d+$/.test(port) ||
        Number(port) < 1 ||
        Number(port) > 65535)
    )
      issue('telegramBotProxyPort', 'proxy');
  }
  if (provider === 'webhook') {
    if (
      !String(values.webhookUrl || '').includes('$title') &&
      !String(values.webhookBody || '').includes('$title')
    )
      issue('webhookBody', 'template');
  }
  if (provider === 'weWorkApp') {
    for (const name of [
      'corpId',
      'corpSecret',
      'toUser',
      'agentId',
      'thumbMediaId',
    ]) {
      if (
        typeof values[name] === 'string' &&
        /[,\r\n]/.test(String(values[name]))
      )
        issue(name, 'delimiter');
    }
    if (
      values.messageType === 'mpnews' &&
      ['0', '1'].includes(String(values.thumbMediaId))
    )
      issue('thumbMediaId', 'thumbnail');
  }
  if (provider === 'wxPusherBot') {
    const topicIds =
      typeof values.wxPusherBotTopicIds === 'string'
        ? values.wxPusherBotTopicIds.split(';').filter((value) => value.trim())
        : [];
    const uids =
      typeof values.wxPusherBotUids === 'string'
        ? values.wxPusherBotUids.split(';').filter((value) => value.trim())
        : [];
    if (!topicIds.length && !uids.length)
      issue('wxPusherBotTopicIds', 'recipients');
    if (!isEmpty(values.wxPusherBotUids) && !uids.length)
      issue('wxPusherBotUids', 'recipients');
    if (
      !isEmpty(values.wxPusherBotTopicIds) &&
      (!topicIds.length ||
        typeof values.wxPusherBotTopicIds !== 'string' ||
        !values.wxPusherBotTopicIds
          .split(';')
          .filter((v) => v.trim())
          .every((v) => /^[1-9]\d*$/.test(v.trim())))
    )
      issue('wxPusherBotTopicIds', 'topicIds');
  }
  if (
    provider === 'wxPusherSpt' &&
    typeof values.wxPusherSptList === 'string'
  ) {
    const count = values.wxPusherSptList
      .split(',')
      .filter((v) => v.trim()).length;
    if (count < 1 || count > 10) issue('wxPusherSptList', 'spt');
  }
  return issues;
}
export class ProviderConfigError extends Error {
  constructor(readonly issues: ProviderValidationIssue[]) {
    super('PROVIDER_CONFIG_INVALID');
  }
}
export function serializeProviderConfig(
  provider: string,
  input: ProviderConfig,
): Record<string, string | number | boolean> {
  const issues = validateProviderConfig(provider, input);
  if (issues.length) throw new ProviderConfigError(issues);
  const schema = schemaFor(provider)!;
  const values = { ...getProviderDefaults(provider), ...input };
  const result: Record<string, string | number | boolean> = {};
  for (const field of schema.fields) {
    if (
      field.wire === false ||
      !isProviderFieldVisible(field, values) ||
      isEmpty(values[field.name])
    )
      continue;
    const value = values[field.name];
    if (field.type === 'keyValue') {
      const headers =
        typeof value === 'string'
          ? value
          : (value as Array<{ key: string; value: string }>)
              .map((row) => `${row.key}: ${row.value}`)
              .join('\n');
      if (headers) result[field.name] = headers;
    } else result[field.name] = value as string | number | boolean;
  }
  if (provider === 'weWorkApp') {
    const fifth =
      values.messageType === 'mpnews'
        ? values.thumbMediaId
        : values.messageType === 'textcard'
        ? '0'
        : '1';
    result.weWorkAppKey = [
      values.corpId,
      values.corpSecret,
      values.toUser,
      values.agentId,
      fifth,
    ].join(',');
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768)
    throw new ProviderConfigError([
      { field: '', messageKey: 'notifications.validation.invalid' },
    ]);
  return result;
}
/** For explicit local drafts only. Channel GET/list responses intentionally contain no config. */
export function deserializeProviderConfig(
  provider: string,
  input: ProviderConfig,
): ProviderConfig {
  if (!safeConfig(input) || !schemaFor(provider))
    throw new ProviderConfigError([
      { field: '', messageKey: 'notifications.validation.invalid' },
    ]);
  const schema = schemaFor(provider)!;
  const values: ProviderConfig = { ...getProviderDefaults(provider) };
  for (const key of schema.wireFields)
    if (Object.prototype.hasOwnProperty.call(input, key))
      values[key] = input[key];
  if (provider === 'email')
    values.emailMode = input.emailHost ? 'smtp' : 'service';
  if (provider === 'ntfy')
    values.ntfyAuthMode = input.ntfyToken
      ? 'token'
      : input.ntfyUsername || input.ntfyPassword
      ? 'basic'
      : 'none';
  if (provider === 'weWorkApp' && typeof input.weWorkAppKey === 'string') {
    const [corpId, corpSecret, toUser, agentId, fifth = '1'] =
      input.weWorkAppKey.split(',');
    Object.assign(values, {
      corpId,
      corpSecret,
      toUser,
      agentId,
      messageType:
        fifth === '1' ? 'text' : fifth === '0' ? 'textcard' : 'mpnews',
      ...(fifth === '0' || fifth === '1' ? {} : { thumbMediaId: fifth }),
    });
    delete values.weWorkAppKey;
  }
  if (provider === 'webhook' && typeof input.webhookHeaders === 'string') {
    values.webhookHeaders = input.webhookHeaders
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const index = line.indexOf(':');
        return {
          key: line.slice(0, index),
          value: line.slice(index + 1).replace(/^ /, ''),
        };
      });
  }
  return values;
}

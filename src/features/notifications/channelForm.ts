import { serializeProviderConfig } from './providerSchemas';

export type SecretAction = 'KEEP' | 'REPLACE' | 'DELETE';
export interface ChannelFormValues {
  name: string;
  type: string;
  enabled: boolean;
  is_default: boolean;
  secret_action: SecretAction;
  providerConfig?: Record<string, unknown>;
  confirmClear?: boolean;
}

/** Only these metadata fields may cross the existing channel API boundary. */
export function createChannelPayload(
  values: ChannelFormValues,
  editing?: { id?: number; type: string; version?: number },
) {
  const action = editing?.id ? values.secret_action : 'REPLACE';
  if (
    !['KEEP', 'REPLACE', 'DELETE'].includes(action) ||
    (editing?.id && editing.type !== values.type && action !== 'REPLACE') ||
    (action === 'DELETE' && values.confirmClear !== true)
  )
    throw new Error('CHANNEL_FORM_INVALID');
  return {
    name: values.name,
    type: values.type,
    enabled: values.enabled,
    is_default: values.is_default,
    secret_action: action,
    ...(editing?.id ? { expected_version: editing.version } : {}),
    ...(action === 'REPLACE'
      ? {
          secret: serializeProviderConfig(
            values.type,
            values.providerConfig || {},
          ),
        }
      : {}),
  };
}

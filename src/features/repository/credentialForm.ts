export interface CredentialFormValues {
  name?: string;
  provider?: string;
  auth_type?: string;
  username?: string;
  capability?: string;
  status?: string;
  known_hosts?: string;
  token?: string;
  private_key?: string;
  passphrase?: string;
}

export interface EditingCredential {
  id?: number;
  auth_type?: string;
  has_secret?: boolean;
}

// Only public, editable metadata and the active authentication material may
// reach the API. Hidden fields and stale form defaults are never forwarded.
export function serializeCredentialInput(
  values: CredentialFormValues,
  editing?: EditingCredential,
) {
  const auth = values.auth_type;
  if (
    !['anonymous', 'https_token', 'ssh_key'].includes(auth || '') ||
    (editing?.id && auth !== editing.auth_type)
  )
    throw new Error('CREDENTIAL_AUTH_TYPE_INVALID');

  const metadata = {
    name: values.name,
    provider: values.provider,
    auth_type: auth,
    username: values.username,
    capability: values.capability,
    status: values.status,
    ...(auth !== 'https_token' ? { known_hosts: values.known_hosts } : {}),
  };
  if (auth === 'anonymous') return { ...metadata, replace_secret: false };

  const material = auth === 'https_token' ? values.token : values.private_key;
  if (typeof material === 'string' && material.length > 0)
    return {
      ...metadata,
      replace_secret: true,
      ...(auth === 'https_token'
        ? { token: material }
        : { private_key: material, passphrase: values.passphrase || '' }),
    };

  if (!editing?.id || !editing.has_secret)
    throw new Error('CREDENTIAL_SECRET_REQUIRED');
  return { ...metadata, replace_secret: false };
}

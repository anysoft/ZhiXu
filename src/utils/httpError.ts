import { translateError } from './i18n';
export interface ValidationErrorResponse {
  errors?: Array<{ message?: string; value?: unknown }>;
  validation?: Record<
    string,
    { source?: string; keys?: string[]; message?: string }
  >;
}

// Only explicitly typed error codes reach UI. Validation values and raw messages may contain secrets.
export const getErrorDetails = (data?: ValidationErrorResponse) => {
  const codes = (data?.errors || [])
    .map((item) => item.message)
    .filter(
      (value): value is string =>
        typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(value),
    );
  return [...new Set(codes)].map(translateError);
};

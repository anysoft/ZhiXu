import { translateError, t as tr } from './i18n';
import { unauthorizedDecision } from './authFailure';
import { message, notification } from 'antd';
import config from './config';
import { history } from '@umijs/max';
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import { getErrorDetails, ValidationErrorResponse } from './httpError';

export interface IResponseData extends ValidationErrorResponse {
  code?: number;
  data?: any;
  message?: string;
  error?: any;
  error_code?: string;
}

export type Override<
  T,
  K extends Partial<{ [P in keyof T]: any }> | string,
> = K extends string
  ? Omit<T, K> & { [P in keyof T]: T[P] | unknown }
  : Omit<T, keyof K> & K;

export interface ICustomConfig {
  onError?: (res: AxiosResponse<unknown, any>) => void;
}

message.config({
  duration: 2,
});

const time = Date.now();
const errorHandler = function (
  error: Override<
    AxiosError<IResponseData>,
    { config: InternalAxiosRequestConfig & ICustomConfig }
  >,
) {
  if (error.response) {
    const msg = translateError(
      error.response.data?.error_code ?? error.response.data?.message,
    );
    const errorDetails = getErrorDetails(error.response.data);
    const responseStatus = error.response.status;
    if ([502, 504].includes(responseStatus)) {
      history.push('/error');
    } else if (responseStatus === 401) {
      handleUnauthorized(error.config);
    } else {
      if (typeof error.config?.onError === 'function') {
        return error.config?.onError(error.response);
      }

      msg &&
        notification.error({
          message: msg,
          description: errorDetails.length ? (
            <>
              {errorDetails.map((detail, index) => (
                <div key={`${index}-${detail}`}>{detail}</div>
              ))}
            </>
          ) : undefined,
        });
    }
  } else {
    message.error(translateError('NETWORK_ERROR'));
  }

  return Promise.reject(error);
};

let _request = axios.create({
  timeout: 60000,
  params: { t: time },
});

const apiWhiteList = [
  `${config.baseUrl}api/user/login`,
  `${config.baseUrl}open/auth/token`,
  `${config.baseUrl}api/user/two-factor/login`,
  `${config.baseUrl}api/system`,
  `${config.baseUrl}api/user/init`,
  `${config.baseUrl}api/user/notification/init`,
];

function handleUnauthorized(requestConfig?: InternalAxiosRequestConfig) {
  const url = (requestConfig?.url || '').split(/[?#]/)[0];
  const authorization = requestConfig?.headers?.Authorization;
  const requestToken =
    typeof authorization === 'string' && /^Bearer /i.test(authorization)
      ? authorization.slice(7)
      : null;
  const decision = unauthorizedDecision({
    pathname:
      window.location.pathname.slice(
        config.baseUrl.replace(/\/$/, '').length,
      ) || '/',
    publicRequest: apiWhiteList.includes(url),
    loginRequest: [
      `${config.baseUrl}api/user/login`,
      `${config.baseUrl}api/user/two-factor/login`,
    ].includes(url),
    requestToken,
    currentToken: localStorage.getItem(config.authKey),
  });
  if (!decision) return;
  if (decision.clear) localStorage.removeItem(config.authKey);
  message.error({
    key: 'authentication-failure',
    content:
      decision.reason === 'ui.auth.loginRequired'
        ? tr('ui.auth.loginRequired')
        : decision.reason === 'ui.auth.expired'
        ? tr('ui.auth.expired')
        : decision.reason === 'ui.auth.loginRejected'
        ? tr('ui.auth.loginRejected')
        : tr('ui.auth.invalid'),
  });
  if (decision.redirect) history.push('/login');
}

_request.interceptors.request.use((_config) => {
  const token = localStorage.getItem(config.authKey);
  if (token && !apiWhiteList.includes(_config.url!)) {
    _config.headers.Authorization = `Bearer ${token}`;
    return _config;
  }
  return _config;
});

_request.interceptors.response.use(async (response) => {
  const responseStatus = response.status;
  if ([502, 504].includes(responseStatus)) {
    history.push('/error');
  } else if (responseStatus === 401) {
    handleUnauthorized(response.config);
  } else {
    try {
      const res = response.data;
      if (res.code !== 200) {
        notification.error({
          message: translateError(res.error_code ?? res.message),
        });
      }
      return res;
    } catch (error) {}
    return response;
  }
  return response;
}, errorHandler);

export const request = _request as Override<
  AxiosInstance,
  {
    get<T = IResponseData, D = any>(
      url: string,
      config?: AxiosRequestConfig<D> & ICustomConfig,
    ): Promise<T>;
    delete<T = IResponseData, D = any>(
      url: string,
      config?: AxiosRequestConfig<D> & ICustomConfig,
    ): Promise<T>;
    post<T = IResponseData, D = any>(
      url: string,
      data?: D,
      config?: AxiosRequestConfig<D> & ICustomConfig,
    ): Promise<T>;
    put<T = IResponseData, D = any>(
      url: string,
      data?: D,
      config?: AxiosRequestConfig<D> & ICustomConfig,
    ): Promise<T>;
  }
>;

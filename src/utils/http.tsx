import { translateError } from './i18n';
import intl from 'react-intl-universal';
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
      if (history.location.pathname !== '/login') {
        message.error(intl.get('登录已过期，请重新登录'));
        localStorage.removeItem(config.authKey);
        history.push('/login');
      }
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
    if (history.location.pathname !== '/login') {
      localStorage.removeItem(config.authKey);
      history.push('/login');
    }
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

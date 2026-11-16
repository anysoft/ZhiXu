import { Joi } from 'celebrate';

/** A selection only; credentials are resolved by the operation owner. */
export const runtimeProxySelection = Joi.object({
  mode: Joi.string().valid('INHERIT', 'DIRECT', 'PROFILE').required(),
  profile_id: Joi.string().allow(null),
}).unknown(false);

import Joi from 'joi';

/** A required, trimmed, non-empty string; `message` is used whether it is missing, blank or not a string. */
export const requiredString = (message: string) =>
  Joi.string().trim().required().messages({
    'any.required': message,
    'string.empty': message,
    'string.base': message,
  });

/** A trimmed string that may be absent; blank is treated as absent. */
export const optionalString = Joi.string().trim().empty('');

/** Like optionalString, but absent becomes null (for fields stored as null). */
export const nullableString = Joi.string().trim().empty('').allow(null).default(null);

/** Route param `:id`. */
export const idParams = Joi.object<IdParams>({
  id: Joi.string().required(),
});

export type IdParams = { id: string };

/**
 * Keeps the value only when it is an array; anything else becomes `fallback`.
 * For optional list fields the caller never had to get exactly right.
 */
export const lenientArray = (items: Joi.Schema, fallback: unknown[] | undefined) =>
  Joi.any().custom((value) => {
    if (!Array.isArray(value)) return fallback;
    return items.validate(value).error ? fallback : value;
  });

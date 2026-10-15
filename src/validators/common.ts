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

/** An id GTWY may send as a number (org_id 11202) or a string; numbers are stored as strings. */
const numericId = Joi.number().custom((value: number) => String(value));
export const optionalId = Joi.alternatives(numericId, optionalString);
export const nullableId = Joi.alternatives(numericId, nullableString).default(null);

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

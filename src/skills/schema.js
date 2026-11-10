/**
 * Typed output check with one repair retry (WP15).
 *
 * The schema is the small subset skill files need, not full JSON Schema:
 * `type` object / string / number / integer / boolean / array, `required`,
 * `properties`, `maxLength`, `minLength`, `minimum`, `maximum`, and `enum`.
 *
 * Repair is mechanical, not a model call:
 * - a missing required string is filled from the brief objective
 * - a string over `maxLength` is cut
 * - a missing number becomes `minimum` or 0
 * - a value outside an `enum` is left alone
 *
 * Leaving enums alone is deliberate. Guessing `pass` would hide a real
 * contract failure. The second check then fails and the step is blocked.
 * There is no third try.
 *
 * @module skills/schema
 */

/**
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} path
 * @returns {string[]}
 */
function checkValue(value, schema, path) {
  /** @type {string[]} */
  const errors = [];
  if (!schema || typeof schema !== 'object') {
    return errors;
  }
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} must be an object`];
    }
    const record = /** @type {Record<string, any>} */ (value);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (record[key] === undefined || record[key] === null) {
        errors.push(`${path}.${key} is required`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined) {
        errors.push(...checkValue(record[key], child, `${path}.${key}`));
      }
    }
    return errors;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      return [`${path} must be a string`];
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} is longer than ${schema.maxLength}`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} is shorter than ${schema.minLength}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    }
    return errors;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [`${path} must be a number`];
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      errors.push(`${path} must be an integer`);
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} is below ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} is above ${schema.maximum}`);
    }
    return errors;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      return [`${path} must be a boolean`];
    }
    return errors;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      return [`${path} must be an array`];
    }
    return errors;
  }
  return errors;
}

/**
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateOutput(value, schema) {
  const errors = checkValue(value, schema, '$');
  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} fallbackString
 * @returns {any}
 */
function repairValue(value, schema, fallbackString) {
  if (!schema || schema.type !== 'object') {
    return value;
  }
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { .../** @type {Record<string, any>} */ (value) }
    : {};
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  for (const [key, child] of Object.entries(properties)) {
    let current = source[key];
    if (current === undefined || current === null) {
      if (!required.has(key)) continue;
      if (child.type === 'string' && !Array.isArray(child.enum)) {
        current = fallbackString || 'incomplete';
      } else if (child.type === 'number' || child.type === 'integer') {
        current = typeof child.minimum === 'number' ? child.minimum : 0;
      } else if (child.type === 'boolean') {
        current = false;
      } else if (child.type === 'array') {
        current = [];
      } else if (child.type === 'object') {
        current = {};
      } else {
        continue;
      }
    }
    if (child.type === 'string' && typeof current !== 'string') {
      current = String(current);
    }
    if ((child.type === 'number' || child.type === 'integer') && typeof current !== 'number') {
      const parsed = Number(current);
      if (Number.isFinite(parsed)) current = parsed;
    }
    if (child.type === 'string' && typeof current === 'string' && typeof child.maxLength === 'number') {
      current = current.slice(0, child.maxLength);
    }
    if (
      (child.type === 'number' || child.type === 'integer') &&
      typeof current === 'number'
    ) {
      if (typeof child.minimum === 'number' && current < child.minimum) current = child.minimum;
      if (typeof child.maximum === 'number' && current > child.maximum) current = child.maximum;
    }
    source[key] = current;
  }
  return source;
}

/**
 * Validate, and if that fails repair once and validate again.
 *
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {{fallbackString?: string}} [context]
 * @returns {{ok: boolean, value: any, repaired: boolean, attempts: number, errors: string[]}}
 */
export function validateWithOneRepair(value, schema, context = {}) {
  const first = validateOutput(value, schema);
  if (first.ok) {
    return { ok: true, value, repaired: false, attempts: 1, errors: [] };
  }
  const repaired = repairValue(value, schema, context.fallbackString || '');
  const second = validateOutput(repaired, schema);
  return {
    ok: second.ok,
    value: repaired,
    repaired: true,
    attempts: 2,
    errors: second.errors,
  };
}

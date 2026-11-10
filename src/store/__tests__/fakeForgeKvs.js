/**
 * Test double for the subset of `@forge/kvs` used by forgeAdapter.js.
 *
 * It implements:
 * - `kvs.entity(name).get/set/delete`
 * - `kvs.entity(name).query().index().where().sort().cursor().limit().getMany()`
 * - `FAIL_IF_EXISTS`
 * - `kvs.transact().set(...conditions...).execute()`
 * - Sort, WhereConditions, FilterConditions, and Filter
 *
 * Queries use the same index definitions as the memory adapter, return
 * `{key, value}` items, and page with an opaque cursor. `maxPageSize` is
 * deliberately smaller than Forge's 100 in pagination tests so the adapter
 * has to follow `nextCursor`.
 *
 * @module store/__tests__/fakeForgeKvs
 */

import { MEMORY_INDEX_DEFINITIONS } from '../memoryAdapter.js';

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function compareValues(left, right) {
  if (left === right) return 0;
  return /** @type {number|string} */ (left) < /** @type {number|string} */ (right)
    ? -1
    : 1;
}

/** @returns {{condition: string, value: number|string}} */
const where = {
  lessThan: (value) => ({ condition: 'LESS_THAN', value }),
  lessThanEqualTo: (value) => ({ condition: 'LESS_THAN_EQUAL', value }),
  greaterThan: (value) => ({ condition: 'GREATER_THAN', value }),
  greaterThanEqualTo: (value) => ({ condition: 'GREATER_THAN_EQUAL', value }),
  equalTo: (value) => ({ condition: 'EQUAL', value }),
};

/** @returns {{condition: string, value: unknown}} */
const filter = {
  equalTo: (value) => ({ condition: 'EQUAL', value }),
};

class FakeFilter {
  constructor() {
    this.items = [];
  }

  and(field, condition) {
    this.items.push({ field, ...condition });
    return this;
  }
}

/**
 * @param {{maxPageSize?: number}} [options]
 */
export function createFakeForgeSdk(options = {}) {
  const maxPageSize = options.maxPageSize ?? 100;
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  const tables = new Map();
  const calls = {
    /** @type {Array<{entityName: string, key: string, value: Record<string, unknown>, options: unknown}>} */
    set: [],
    /** @type {Array<{ops: Array<{key: string, entityName: string, value: Record<string, unknown>}>}>} */
    transactions: [],
    /** @type {Array<Record<string, unknown>>} */
    queries: [],
  };

  function table(entityName) {
    let rows = tables.get(entityName);
    if (!rows) {
      rows = new Map();
      tables.set(entityName, rows);
    }
    return rows;
  }

  function conditionMatches(actual, condition) {
    if (!condition) return true;
    const order = compareValues(actual, condition.value);
    switch (condition.condition) {
      case 'LESS_THAN':
        return order < 0;
      case 'LESS_THAN_EQUAL':
        return order <= 0;
      case 'GREATER_THAN':
        return order > 0;
      case 'GREATER_THAN_EQUAL':
        return order >= 0;
      case 'EQUAL':
        return order === 0;
      default:
        throw new Error(`Unknown condition ${condition.condition}`);
    }
  }

  class QueryBuilder {
    constructor(entityName) {
      this.entityName = entityName;
      this.indexName = undefined;
      this.partition = [];
      this.condition = undefined;
      this.direction = 'ASC';
      this.cursorValue = undefined;
      this.limitValue = undefined;
    }

    index(name, indexOptions = {}) {
      this.indexName = name;
      this.partition = indexOptions.partition ?? [];
      return this;
    }

    where(condition) {
      this.condition = condition;
      return this;
    }

    sort(direction) {
      this.direction = direction;
      return this;
    }

    cursor(cursor) {
      this.cursorValue = cursor;
      return this;
    }

    limit(limit) {
      this.limitValue = limit;
      return this;
    }

    async getMany() {
      const definition =
        MEMORY_INDEX_DEFINITIONS[this.entityName]?.[this.indexName];
      if (!definition) {
        throw new Error(
          `Unknown index ${this.entityName}.${String(this.indexName)}`,
        );
      }
      calls.queries.push({
        entityName: this.entityName,
        indexName: this.indexName,
        partition: [...this.partition],
        condition: this.condition,
        direction: this.direction,
        cursor: this.cursorValue,
        limit: this.limitValue,
      });

      const rows = [...table(this.entityName).entries()]
        .map(([key, value]) => ({ key, value }))
        .filter((row) =>
          definition.partition.every(
            (attribute, index) =>
              row.value[attribute] === this.partition[index],
          ),
        )
        .filter((row) => {
          const rangeValue = row.value[definition.range];
          if (rangeValue === undefined || rangeValue === null) {
            return false;
          }
          return conditionMatches(rangeValue, this.condition);
        })
        .sort((left, right) => {
          const order = compareValues(
            left.value[definition.range],
            right.value[definition.range],
          );
          if (order !== 0) {
            return this.direction === 'DESC' ? -order : order;
          }
          return left.key.localeCompare(right.key);
        });

      const requestedLimit =
        this.limitValue === undefined ? 10 : this.limitValue;
      const pageSize = Math.max(1, Math.min(requestedLimit, maxPageSize));
      let start = 0;
      if (this.cursorValue) {
        const match = /^cursor:(\d+)$/.exec(this.cursorValue);
        if (!match) throw new Error(`Bad cursor ${this.cursorValue}`);
        start = Number(match[1]);
      }
      const page = rows.slice(start, start + pageSize);
      const end = start + page.length;
      return {
        results: page.map((row) => ({
          key: row.key,
          value: clone(row.value),
        })),
        nextCursor: end < rows.length ? `cursor:${end}` : undefined,
      };
    }
  }

  function entity(entityName) {
    return {
      async get(key) {
        const value = table(entityName).get(key);
        return value === undefined ? undefined : clone(value);
      },

      async set(key, value, setOptions) {
        calls.set.push({
          entityName,
          key,
          value: clone(value),
          options: setOptions,
        });
        if (
          setOptions?.keyPolicy === 'FAIL_IF_EXISTS' &&
          table(entityName).has(key)
        ) {
          throw new Error(`key ${key} already exists`);
        }
        table(entityName).set(key, clone(value));
      },

      async delete(key) {
        table(entityName).delete(key);
      },

      query() {
        return new QueryBuilder(entityName);
      },
    };
  }

  class TransactionBuilder {
    constructor() {
      this.ops = [];
    }

    set(key, value, setOptions) {
      this.ops.push({ key, value, options: setOptions });
      return this;
    }

    delete(key, deleteOptions) {
      this.ops.push({ key, options: deleteOptions, delete: true });
      return this;
    }

    async execute() {
      calls.transactions.push({ ops: clone(this.ops) });
      // Validate every condition before applying any write.
      for (const op of this.ops) {
        if (op.delete) continue;
        const conditions = op.options?.conditions?.items ?? [];
        const current = table(op.options.entityName).get(op.key);
        for (const condition of conditions) {
          if (
            !current ||
            current[condition.field] !== condition.value
          ) {
            throw new Error('Transaction condition not met');
          }
        }
      }
      for (const op of this.ops) {
        if (op.delete) {
          table(op.options.entityName).delete(op.key);
        } else {
          calls.set.push({
            entityName: op.options.entityName,
            key: op.key,
            value: clone(op.value),
            options: { transaction: true },
          });
          table(op.options.entityName).set(op.key, clone(op.value));
        }
      }
    }
  }

  const kvs = {
    entity,
    transact() {
      return new TransactionBuilder();
    },
  };

  return {
    kvs,
    WhereConditions: where,
    FilterConditions: filter,
    Filter: FakeFilter,
    Sort: { ASC: 'ASC', DESC: 'DESC' },
    calls,
    debug: {
      get(entityName, key) {
        const value = table(entityName).get(key);
        return value === undefined ? undefined : clone(value);
      },
      size(entityName) {
        return table(entityName).size;
      },
    },
  };
}

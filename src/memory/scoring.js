/**
 * Keyword scoring for WP6 run memory (docs/TASKS.md, docs/SPIKES.md).
 *
 * There is no vector database in the MVP. `recall` reads the project's memory
 * rows from the WP1 `by-project` index, then ranks them here with a small,
 * deterministic keyword overlap score. The scoring rules are intentionally
 * boring so a demo can explain why a memory was recalled:
 *
 * 1. Tokenise the query and each memory's searchable text.
 * 2. A query token that appears in the memory text scores 1 point.
 * 3. A query token that matches the memory category (`decision`, `lesson`,
 *    `fact`) scores 0.75 points.
 * 4. Add a coverage bonus so a memory matching every query term outranks one
 *    matching a single term.
 * 5. Add a phrase bonus when the whole normalised query appears in the text.
 *
 * The tokenizer lowercases, splits camelCase/snake_case, strips punctuation,
 * removes English stopwords, and applies a light plural/verb suffix stem.
 * That is enough for goals such as "reconcile the refund ledger" to overlap a
 * decision such as "Refunds are idempotent on the payment id".
 *
 * @module memory/scoring
 */

/**
 * Common English stopwords. They carry little retrieval signal in short goals
 * and would otherwise let a memory match on "the" or "for" alone.
 *
 * @constant {ReadonlySet<string>}
 */
const STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'must',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'one',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'per',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'via',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

/** Matches a doubled final consonant left behind by `-ing` or `-ed`. */
const TRAILING_DOUBLE_CONSONANT = /([bdfglmnprt])\1$/;

/**
 * Split camelCase and acronym boundaries before punctuation handling, so
 * `paymentId`, `PaymentID`, and `payment_id` all produce `payment` + `id`.
 *
 * @param {string} value
 * @returns {string}
 */
function splitWordBoundaries(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/**
 * Normalise free text for phrase comparison.
 *
 * @param {unknown} value
 * @returns {string} Lowercase ASCII-ish text with single spaces.
 */
export function normalizeText(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return splitWordBoundaries(String(value))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Apply a light, deterministic stem. This is not a full Porter stemmer; it
 * handles the plurals and simple verb endings that appear in ticket text
 * ("refunds", "processing", "shipped", "created") without changing meaning.
 *
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
  let value = word;

  if (value.length > 4 && value.endsWith('ies')) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.length > 5 && value.endsWith('yses')) {
    // analyses -> analysis, diagnoses -> diagnosis
    value = `${value.slice(0, -3)}is`;
  } else if (value.length > 5 && value.endsWith('ing')) {
    value = value.slice(0, -3);
  } else if (value.length > 5 && value.endsWith('ed')) {
    const base = value.slice(0, -2);
    // created -> create, generated -> generate, but shipped -> shipp -> ship.
    value = /(at|iz|us|iv|c)$/.test(base) ? `${base}e` : base;
  } else if (value.length > 4 && value.endsWith('sses')) {
    value = value.slice(0, -2);
  } else if (value.length > 4 && /(ses|xes|zes|ches|shes)$/.test(value)) {
    value = value.slice(0, -2);
  } else if (
    value.length > 3 &&
    value.endsWith('s') &&
    !value.endsWith('ss') &&
    !value.endsWith('us') &&
    !value.endsWith('is')
  ) {
    value = value.slice(0, -1);
  }

  if (value.length > 3 && TRAILING_DOUBLE_CONSONANT.test(value)) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Tokenise a string or an array/object of strings into unique stems.
 * Arrays and object values are flattened because `recall` accepts a query
 * object such as `{goal, labels}` as well as a plain string.
 *
 * @param {unknown} value
 * @param {string[]} [out] Accumulator used by recursion.
 * @returns {string[]} Unique stemmed tokens in first-seen order.
 */
export function tokenize(value, out = []) {
  if (value === undefined || value === null) {
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      tokenize(item, out);
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      tokenize(item, out);
    }
    return out;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return out;
  }

  for (const word of normalized.split(' ')) {
    if (word.length < 2 || STOPWORDS.has(word)) {
      continue;
    }
    const stemmed = stem(word);
    if (
      stemmed.length < 2 ||
      STOPWORDS.has(stemmed) ||
      out.includes(stemmed)
    ) {
      continue;
    }
    out.push(stemmed);
  }
  return out;
}

/**
 * Collect every searchable string from a memory row. `text` is the primary
 * field; `sourceIssue` lets a query mention the Epic key, and a future caller
 * may attach Jira `labels` to a memory without changing recall.
 *
 * @param {object} memory
 * @returns {string}
 */
function searchableText(memory) {
  const parts = [];
  if (typeof memory.text === 'string') {
    parts.push(memory.text);
  }
  if (typeof memory.sourceIssue === 'string') {
    parts.push(memory.sourceIssue);
  }
  if (Array.isArray(memory.labels)) {
    for (const label of memory.labels) {
      if (typeof label === 'string') {
        parts.push(label);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Score one memory against one query string.
 *
 * The caller has already removed superseded and expired rows. A score of zero
 * means "no keyword overlap" and must not be recalled.
 *
 * @param {object} memory A WP1 memory record.
 * @param {string} queryText Normalised query text produced by `recall`.
 * @returns {number} Non-negative relevance score.
 */
export function scoreMemory(memory, queryText) {
  if (!memory || typeof memory !== 'object') {
    return 0;
  }
  const queryTokens = new Set(tokenize(queryText));
  if (queryTokens.size === 0) {
    return 0;
  }

  const text = searchableText(memory);
  const textTokens = new Set(tokenize(text));
  const categoryTokens = new Set(
    tokenize(memory.memType ?? memory.type ?? ''),
  );

  let matchedTokens = 0;
  let weight = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matchedTokens += 1;
      weight += 1;
    } else if (categoryTokens.has(token)) {
      matchedTokens += 1;
      weight += 0.75;
    }
  }

  if (matchedTokens === 0) {
    return 0;
  }

  // Coverage rewards a memory that matches more of the query, not just one
  // unusually common term.
  let score = weight + matchedTokens / queryTokens.size;

  const normalizedQuery = normalizeText(queryText);
  if (
    normalizedQuery.length >= 3 &&
    normalizeText(text).includes(normalizedQuery)
  ) {
    score += 2;
  }
  return score;
}

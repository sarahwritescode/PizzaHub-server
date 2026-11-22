import { isDeepStrictEqual } from "node:util";
import type { Db } from "mongodb";

import { getDB } from "./db.js";
import {
  collectionDefinitions,
  type CollectionDefinition,
  type IndexDefinition,
} from "../models/index.js";

export interface InitReport {
  collectionsCreated: string[];
  validatorsUpdated: string[];
  indexesCreated: string[];
  indexesAlreadyPresent: string[];
  /** Things that could not be done safely. Nothing is ever deleted to resolve them. */
  problems: string[];
}

// MongoDB error codes
const NAMESPACE_NOT_FOUND = 26;
const NAMESPACE_EXISTS = 48;
const INDEX_OPTIONS_CONFLICT = 85;
const INDEX_KEY_SPECS_CONFLICT = 86;
const DUPLICATE_KEY = 11000;

const codeOf = (error: unknown) => (error as { code?: number }).code;

const VALIDATION = { validationLevel: "strict", validationAction: "error" } as const;

const ensureCollection = async (
  db: Db,
  definition: CollectionDefinition,
  report: InitReport
) => {
  const { name, validator } = definition;

  // `users` (and anything without a validator) is managed elsewhere: only
  // indexes are ensured for it; createIndex creates the collection if needed.
  if (!validator) return;

  const [existing] = await db.listCollections({ name }, { nameOnly: false }).toArray();

  if (!existing) {
    try {
      await db.createCollection(name, { validator, ...VALIDATION });
      report.collectionsCreated.push(name);
    } catch (error) {
      if (codeOf(error) !== NAMESPACE_EXISTS) throw error; // created by a parallel start
    }
    return;
  }

  // Compare first so a normal restart changes nothing. collMod only replaces
  // the validation rules, it never touches documents.
  if (!isDeepStrictEqual(existing.options?.validator, validator)) {
    await db.command({ collMod: name, validator, ...VALIDATION });
    report.validatorsUpdated.push(name);
  }
};

const listIndexes = async (db: Db, collection: string) => {
  try {
    return await db.collection(collection).indexes();
  } catch (error) {
    if (codeOf(error) === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
};

const ensureIndex = async (
  db: Db,
  collection: string,
  index: IndexDefinition,
  report: InitReport
) => {
  const label = `${collection}.${index.name}`;

  const findSameKey = async () =>
    (await listIndexes(db, collection)).find((existing) =>
      isDeepStrictEqual(existing.key, index.key)
    );

  const alreadyThere = async () => {
    const existing = await findSameKey();
    if (!existing) return false;

    if (
      !isDeepStrictEqual(existing.partialFilterExpression ?? null, index.partialFilterExpression ?? null)
    ) {
      report.problems.push(
        `${label}: an index on ${JSON.stringify(index.key)} already exists ("${existing.name}") with a different partial filter. Left untouched.`
      );
    } else if (Boolean(existing.unique) !== Boolean(index.unique)) {
      report.problems.push(
        `${label}: an index on ${JSON.stringify(index.key)} already exists ` +
          `("${existing.name}") but unique=${Boolean(existing.unique)}, expected unique=${Boolean(index.unique)}. Left untouched.`
      );
    } else {
      report.indexesAlreadyPresent.push(`${collection}.${existing.name}`);
    }

    return true;
  };

  if (await alreadyThere()) return;

  try {
    await db
      .collection(collection)
      .createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    report.indexesCreated.push(label);
  } catch (error) {
    const code = codeOf(error);

    if (code === DUPLICATE_KEY) {
      report.problems.push(
        `${label}: cannot create the UNIQUE index because the collection already contains duplicate values ` +
          `for ${JSON.stringify(index.key)}. Nothing was deleted: fix the duplicates, then restart.`
      );
    } else if (code === INDEX_OPTIONS_CONFLICT || code === INDEX_KEY_SPECS_CONFLICT) {
      // Someone else (for example Better Auth) created it a moment ago, or an
      // index with this name but a different definition exists.
      if (!(await alreadyThere())) {
        report.problems.push(
          `${label}: conflicts with an existing index of the same name but a different definition. Left untouched.`
        );
      }
    } else {
      throw error;
    }
  }
};

/**
 * Makes sure the four business collections, their validators and indexes exist.
 * Safe to run on every start: whatever already exists is left alone, and
 * nothing is ever dropped or deleted. Throws if MongoDB is unreachable.
 */
export const initializeDatabase = async (db: Db = getDB()): Promise<InitReport> => {
  const report: InitReport = {
    collectionsCreated: [],
    validatorsUpdated: [],
    indexesCreated: [],
    indexesAlreadyPresent: [],
    problems: [],
  };

  for (const definition of collectionDefinitions) {
    await ensureCollection(db, definition, report);

    for (const index of definition.indexes) {
      await ensureIndex(db, definition.name, index, report);
    }
  }

  return report;
};

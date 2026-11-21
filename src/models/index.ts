import { getDB } from "../config/db.js";

import { COLLECTIONS, type CollectionDefinition } from "./common.js";
import { menuItemsDefinition, type MenuItem } from "./menuItem.model.js";
import { ordersDefinition, type Order } from "./order.model.js";
import { transactionsDefinition, type Transaction } from "./transaction.model.js";
import { usersDefinition, type UserDoc } from "./user.model.js";

export * from "./common.js";
export * from "./user.model.js";
export * from "./menuItem.model.js";
export * from "./order.model.js";
export * from "./transaction.model.js";

/** Everything initializeDatabase() has to guarantee. Exactly these 4 business collections. */
export const collectionDefinitions: CollectionDefinition[] = [
  usersDefinition,
  menuItemsDefinition,
  ordersDefinition,
  transactionsDefinition,
];

// Typed accessors (call only after connectDB()).
export const usersCollection = () => getDB().collection<UserDoc>(COLLECTIONS.users);
export const menuItemsCollection = () => getDB().collection<MenuItem>(COLLECTIONS.menuItems);
export const ordersCollection = () => getDB().collection<Order>(COLLECTIONS.orders);
export const transactionsCollection = () =>
  getDB().collection<Transaction>(COLLECTIONS.transactions);

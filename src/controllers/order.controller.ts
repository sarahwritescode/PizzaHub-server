import { ObjectId } from "mongodb";
import type { Request, Response } from "express";

import * as orders from "../services/order.service.js";
import { parseWith } from "../utils/validate.js";
import {
  createOrderBodySchema,
  emptyBodySchema,
  myOrdersQuerySchema,
  orderParamsSchema,
} from "../validations/order.validation.js";

// These handlers run behind requireRole("customer"), so req.auth is always set.
// The customer is the verified, database-loaded user: never a value from the request.
const customerIdOf = (req: Request) => new ObjectId(req.auth!.user.id);

export const createOrder = async (req: Request, res: Response) => {
  const input = parseWith(createOrderBodySchema, req.body ?? {});
  const order = await orders.createOrder(customerIdOf(req), input);

  res.status(201).json({
    success: true,
    message: "Order placed successfully. It is waiting for the vendor.",
    data: order,
  });
};

export const getMyOrders = async (req: Request, res: Response) => {
  const query = parseWith(myOrdersQuerySchema, req.query);
  const { items, pagination } = await orders.listMyOrders(customerIdOf(req), query);

  res.status(200).json({
    success: true,
    message: "Your orders fetched successfully",
    data: items,
    pagination,
  });
};

export const getOrderById = async (req: Request, res: Response) => {
  const { id } = parseWith(orderParamsSchema, req.params);
  const order = await orders.getMyOrder(customerIdOf(req), id);

  res.status(200).json({ success: true, message: "Order fetched successfully", data: order });
};

export const cancelOrder = async (req: Request, res: Response) => {
  const { id } = parseWith(orderParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const order = await orders.cancelMyOrder(customerIdOf(req), id);

  res.status(200).json({ success: true, message: "Order cancelled successfully", data: order });
};

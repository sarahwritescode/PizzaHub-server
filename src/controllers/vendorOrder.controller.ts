import { ObjectId } from "mongodb";
import type { Request, Response } from "express";

import * as vendorOrders from "../services/vendorOrder.service.js";
import { parseWith } from "../utils/validate.js";
import { emptyBodySchema, orderParamsSchema, vendorOrdersQuerySchema } from "../validations/order.validation.js";

// These handlers run behind requireRole("vendor"), so req.auth is always set.
// The vendor is the verified, database-loaded user: never a value from the request.
const vendorIdOf = (req: Request) => new ObjectId(req.auth!.user.id);

export const getVendorOrders = async (req: Request, res: Response) => {
  const query = parseWith(vendorOrdersQuerySchema, req.query);
  const { items, pagination } = await vendorOrders.listVendorOrders(vendorIdOf(req), query);

  res.status(200).json({
    success: true,
    message: "Your orders fetched successfully",
    data: items,
    pagination,
  });
};

export const acceptOrder = async (req: Request, res: Response) => {
  const { id } = parseWith(orderParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const order = await vendorOrders.decideVendorOrder(vendorIdOf(req), id, "accepted");

  res.status(200).json({ success: true, message: "Order accepted successfully", data: order });
};

export const rejectOrder = async (req: Request, res: Response) => {
  const { id } = parseWith(orderParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const order = await vendorOrders.decideVendorOrder(vendorIdOf(req), id, "rejected");

  res.status(200).json({ success: true, message: "Order rejected successfully", data: order });
};

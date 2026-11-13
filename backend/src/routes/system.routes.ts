import { Router } from "express";
import { health, listApprovals, ready } from "../controllers/system.controller";

export const systemRoutes: Router = Router();

systemRoutes.get("/health", health);
systemRoutes.get("/ready", ready);
systemRoutes.get("/approvals", listApprovals);

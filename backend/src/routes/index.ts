import { Router } from "express";
import { openApi } from "../config/openapi";
import { alertRoutes } from "./alertRoutes";
import { assistantRoutes } from "./assistant.routes";
import { authRoutes } from "./authRoutes";
import { erpRoutes } from "./erpRoutes";
import { maintenanceRoutes } from "./maintenanceRoutes";
import { systemRoutes } from "./system.routes";
import { uploadRoutes } from "./uploadRoutes";
import { usageRoutes } from "./usageRoutes";

export const routes: Router = Router();

routes.use("/api", systemRoutes);
routes.use("/api/v1/auth", authRoutes);
routes.use("/api/v1/alerts", alertRoutes);
routes.use("/api/v1/uploads", uploadRoutes);
routes.use("/api/v1/maintenance-documents", maintenanceRoutes);
routes.use("/api/v1/erp", erpRoutes);
routes.use("/api/v1/usage", usageRoutes);
routes.use("/api/ai", assistantRoutes);
routes.get("/api/openapi.json", (_req, res) => res.json(openApi));

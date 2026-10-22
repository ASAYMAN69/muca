import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { MucaStore } from '../store/index.js';
import type { PolicyEffect } from '../store/policies.js';

/**
 * The policy routes.
 *
 * A policy is the user's own answer to "may this tool run?". The server
 * makes the decision; the client only writes down what the user wants.
 *
 *   GET    /api/v1/policies        — global and per-session
 *   POST   /api/v1/policies        — a new one
 *   PATCH  /api/v1/policies/:id    — edit, enable, disable, reprioritise
 *   DELETE /api/v1/policies/:id    — remove it
 */
export function createPoliciesRouter(deps: { store: MucaStore }): Router {
  const router = Router();

  const matcherSchema = z.record(z.string(), z.unknown()).nullable().optional();

  const createSchema = z.object({
    toolName: z.string().min(1).max(120),
    match: matcherSchema,
    effect: z.enum(['allow', 'ask', 'deny']),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    label: z.string().max(200).nullable().optional(),
    sessionId: z.string().max(120).nullable().optional(),
  });

  const patchSchema = z.object({
    toolName: z.string().min(1).max(120).optional(),
    match: matcherSchema,
    effect: z.enum(['allow', 'ask', 'deny']).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    label: z.string().max(200).nullable().optional(),
    sessionId: z.string().max(120).nullable().optional(),
  });

  router.get('/policies', (_req: Request, res: Response) => {
    res.json({ policies: deps.store.policies.listAll().map(toJson) });
  });

  router.post('/policies', (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const data = parsed.data;
    const policy = deps.store.policies.create({
      toolName: data.toolName,
      match: data.match ?? null,
      effect: data.effect as PolicyEffect,
      enabled: data.enabled ?? true,
      priority: data.priority ?? 100,
      label: data.label ?? null,
      sessionId: data.sessionId ?? null,
    });

    res.status(201).json({ policy: toJson(policy) });
  });

  router.patch('/policies/:id', (req: Request, res: Response) => {
    const policyId = String(req.params.id);
    const parsed = patchSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const patch = parsed.data;
    const policy = deps.store.policies.update(policyId, {
      ...(patch.toolName !== undefined ? { toolName: patch.toolName } : {}),
      ...(patch.match !== undefined ? { match: patch.match ?? null } : {}),
      ...(patch.effect !== undefined ? { effect: patch.effect as PolicyEffect } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.label !== undefined ? { label: patch.label ?? null } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId ?? null } : {}),
    });

    if (!policy) {
      res.status(404).json({ error: `No policy with id ${policyId}.` });
      return;
    }

    res.json({ policy: toJson(policy) });
  });

  router.delete('/policies/:id', (req: Request, res: Response) => {
    const policyId = String(req.params.id);
    const removed = deps.store.policies.delete(policyId);

    if (!removed) {
      res.status(404).json({ error: `No policy with id ${policyId}.` });
      return;
    }

    res.json({ deleted: true, id: policyId });
  });

  return router;
}

/** The wire shape of a policy. */
function toJson(policy: {
  id: string;
  sessionId: string | null;
  toolName: string;
  match: Record<string, unknown> | null;
  effect: PolicyEffect;
  enabled: boolean;
  priority: number;
  label: string | null;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: policy.id,
    sessionId: policy.sessionId,
    toolName: policy.toolName,
    match: policy.match,
    effect: policy.effect,
    enabled: policy.enabled,
    priority: policy.priority,
    label: policy.label,
    createdAt: policy.createdAt,
  };
}

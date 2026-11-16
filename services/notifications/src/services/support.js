// Learner questions to the LearnLoop team. Learners ask from the Help page and read
// the replies there; staff answer from the Admin page. A reply also lands in the
// learner's inbox. The question text is stored, never logged.
import { randomBytes } from 'node:crypto';
import { badRequest, notFound } from '@learnloop/shared/http';
import { logEvent } from '@learnloop/shared/logger';
import {
  insertSupportRequest, listSupportRequests, listSupportRequestsForUser, updateSupportRequest,
} from '../repositories/supportRequests.js';
import { listUsers } from '../repositories/users.js';
import { createNotification } from './inbox.js';

export const SUPPORT_TOPICS = Object.freeze(['billing', 'certificate', 'account', 'course_content', 'other']);
export const SUPPORT_STATUSES = Object.freeze(['open', 'answered']);
export const MAX_SUPPORT_TEXT = 2000;

const HOUR_MS = 3_600_000;

export const newSupportRequestId = () => `sup_${randomBytes(6).toString('hex')}`;

/**
 * When a reply is due: one business day after the question. 24 hours later, moved
 * on to Monday (same time of day) when that lands on a Saturday or Sunday.
 */
export function replyDueAt(createdAt) {
  const due = new Date(new Date(createdAt).getTime() + 24 * HOUR_MS);
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1);
  return due;
}

/** Open requests whose reply is overdue at `now`, oldest first. */
export function overdueRequests(requests, now = new Date()) {
  return requests
    .filter((r) => r.status === 'open' && replyDueAt(r.created_at) <= now)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function cleanText(value, code) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_SUPPORT_TEXT) throw badRequest(code);
  return text;
}

export function validateSupportRequest({ topic, body } = {}) {
  if (!SUPPORT_TOPICS.includes(topic)) throw badRequest('invalid_topic');
  return { topic, body: cleanText(body, 'invalid_body') };
}

/** A learner asks a question. */
export async function createSupportRequest(userId, input, now = new Date()) {
  const { topic, body } = validateSupportRequest(input);
  const request = await insertSupportRequest({
    id: newSupportRequestId(),
    user_id: userId,
    topic,
    body,
    created_at: now.toISOString(),
    status: 'open',
    replies: [],
    answered_at: null,
  });
  logEvent({ event: 'support_request_created', entityType: 'support_request', entityId: request.id });
  return request;
}

/** A learner's own questions, newest first. */
export async function listUserSupportRequests(userId) {
  return (await listSupportRequestsForUser(userId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/** Staff view: open questions oldest first (the next one to answer on top), answered ones newest answer first. */
export async function listSupportRequestsByStatus(status = 'open') {
  if (!SUPPORT_STATUSES.includes(status)) throw badRequest('invalid_status');
  const all = (await listSupportRequests()).filter((r) => r.status === status);
  return status === 'open'
    ? all.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    : all.sort((a, b) => b.answered_at.localeCompare(a.answered_at) || b.id.localeCompare(a.id));
}

/** A staff member answers. The first reply marks the request answered; the learner gets an inbox notification. */
export async function replyToSupportRequest(staffUserId, requestId, input, now = new Date()) {
  const body = cleanText(input?.body, 'invalid_body');
  const at = now.toISOString();
  const updated = await updateSupportRequest(requestId, (r) => {
    r.replies.push({ staff_id: staffUserId, body, created_at: at });
    if (r.status !== 'answered') {
      r.status = 'answered';
      r.answered_at = at;
    }
  });
  if (!updated) throw notFound('support_request_not_found');
  await createNotification(updated.user_id, {
    type: 'support_reply',
    title: 'The LearnLoop team replied to your question',
    body,
    link: '/help',
  }, now);
  logEvent({ event: 'support_reply_sent', entityType: 'support_request', entityId: updated.id, actorType: 'staff' });
  return updated;
}

/** First name of each staff member, for the reply byline a learner sees. */
export async function staffNames() {
  return new Map((await listUsers()).filter((u) => u.role === 'staff').map((u) => [u.id, u.name.split(' ')[0]]));
}

export function toPublicSupportRequest(r, names = new Map()) {
  return {
    id: r.id,
    topic: r.topic,
    body: r.body,
    createdAt: r.created_at,
    status: r.status,
    answeredAt: r.answered_at,
    replyDueAt: replyDueAt(r.created_at).toISOString(),
    replies: r.replies.map((reply) => ({ body: reply.body, createdAt: reply.created_at, staffName: names.get(reply.staff_id) ?? 'LearnLoop team' })),
  };
}

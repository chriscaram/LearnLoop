export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'request_failed');
  return data;
}

export const errorMessage = (error) => {
  const messages = {
    invalid_credentials: 'That email and password do not match an account.',
    subscription_required: 'An active subscription is needed to enrol.',
    not_enrolled: 'Enrol in this course to open its lessons.',
    already_subscribed: 'You already have an active subscription.',
    no_active_subscription: 'There is no active subscription to cancel.',
  };
  return messages[error?.code] ?? 'Something went wrong. Please try again.';
};

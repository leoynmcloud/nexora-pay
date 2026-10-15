const encoder = new TextEncoder();

function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    mismatch |= (a[index] || 0) ^ (b[index] || 0);
  }
  return mismatch === 0;
}

export function isAuthorizedWebhookWorker(input: {
  authorization: string | null;
  workerTokenHeader: string | null;
  serviceRoleKey: string;
  workerToken: string;
}) {
  const bearer = (input.authorization || '').replace(/^Bearer\s+/i, '');
  const serviceRoleMatch = input.serviceRoleKey.length > 0 && constantTimeEqual(bearer, input.serviceRoleKey);
  const workerTokenMatch = input.workerToken.length >= 32 && !/\s/.test(input.workerToken)
    && constantTimeEqual(input.workerTokenHeader || '', input.workerToken);
  return serviceRoleMatch || workerTokenMatch;
}

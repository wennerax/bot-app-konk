import crypto from 'node:crypto';

export function validateWebAppInitData(initData, botToken, maxAgeSeconds = 86400, clockSkewSeconds = 60) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!receivedHash || !Number.isFinite(authDate) || age < -clockSkewSeconds || age > maxAgeSeconds) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const expectedBuffer = Buffer.from(expectedHash);
  const receivedBuffer = Buffer.from(receivedHash);
  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return null;

  try {
    const user = JSON.parse(params.get('user'));
    return user && Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}
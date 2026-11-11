import { envFingerprintSecret } from './fingerprint-secret';

describe('envFingerprintSecret (4.3)', () => {
  const good = Buffer.alloc(32, 9).toString('base64');

  it('reads a base64 secret and its id', async () => {
    const material = await envFingerprintSecret('S', 'I', { S: good, I: 'k1' }).current();
    expect(material.id).toBe('k1');
    expect(Buffer.from(material.secret).equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it('throws without printing the value when missing or short', () => {
    expect(() => envFingerprintSecret('S', 'I', { I: 'k1' }).current()).toThrow(
      'S and I must both be set',
    );
    const short = Buffer.alloc(16, 9).toString('base64');
    const read = (): unknown => envFingerprintSecret('S', 'I', { S: short, I: 'k1' }).current();
    expect(read).toThrow("'k1' is 16 bytes, below 32");
    expect(read).not.toThrow(short);
    expect(() => envFingerprintSecret('S', 'I', { S: good, I: 'bad id' }).current()).toThrow(
      'invalid secret id',
    );
  });
});

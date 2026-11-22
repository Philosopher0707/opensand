import test from 'node:test';
import * as assert from 'node:assert';
import {
  SECRET_MASK,
  SECRET_VALIDATION_MESSAGE,
  CREDENTIAL_VALIDATION_MESSAGE,
  SECRET_EMPTY_STATE,
  CREDENTIAL_EMPTY_STATE,
  validateSecretInput,
  validateCredentialInput,
  parseSites,
  secretCardView,
  credentialCardView,
} from '../src/shell/vault-model.js';

test('secret input requires a trimmed name and value', () => {
  assert.strictEqual(validateSecretInput({ name: '  ', value: 'x' }), SECRET_VALIDATION_MESSAGE);
  assert.strictEqual(validateSecretInput({ name: 'TOKEN', value: '   ' }), SECRET_VALIDATION_MESSAGE);
  assert.strictEqual(validateSecretInput({ name: '  TOKEN ', value: ' value ' }), null);
});

test('credential input requires title and username, matching the server guard', () => {
  assert.strictEqual(validateCredentialInput({ title: '  ', username: 'a' }), CREDENTIAL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCredentialInput({ title: 'AWS', username: ' ' }), CREDENTIAL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCredentialInput({ title: ' AWS ', username: ' admin@x.com ' }), null);
});

test('parseSites trims entries and drops empties', () => {
  assert.deepStrictEqual(parseSites('a.com, b.com, ,c.com'), ['a.com', 'b.com', 'c.com']);
  assert.deepStrictEqual(parseSites('   '), []);
});

test('secret card never uses preview or any stored value as the mask', () => {
  const card = secretCardView({
    id: 'sec_1',
    name: '  GITHUB_TOKEN ',
    description: '  deploy token ',
    preview: 'S3C...ARY',
    value: 'S3CRET-CANARY',
  } as any);
  assert.strictEqual(card.name, 'GITHUB_TOKEN');
  assert.strictEqual(card.description, 'deploy token');
  assert.strictEqual(card.mask, SECRET_MASK);
  assert.strictEqual(card.mask, '••••••••');
  assert.ok(!JSON.stringify(card).includes('S3CRET-CANARY'), 'canary value is not in the card view');
});

test('secret card falls back to a neutral description', () => {
  assert.strictEqual(secretCardView({ id: 'sec_2', name: 'TOKEN' }).description, 'Environment secret token');
});

test('credential card defaults username and sites, and masks the password', () => {
  const card = credentialCardView({
    id: 'cred_1',
    title: ' AWS ',
    username: '  ',
    sites: 'a.com, b.com',
    password: 'S3CRET-CANARY',
  } as any);
  assert.strictEqual(card.title, 'AWS');
  assert.strictEqual(card.username, 'user');
  assert.strictEqual(card.sites, 'a.com, b.com');
  assert.strictEqual(card.mask, SECRET_MASK);
  assert.ok(!JSON.stringify(card).includes('S3CRET-CANARY'), 'canary password is not in the card view');
  assert.strictEqual(credentialCardView({ id: 'cred_2', title: 'AWS' }).sites, 'Any');
  assert.deepStrictEqual(credentialCardView({ id: 'cred_3', title: 'AWS', sites: ['a.com'] }).sites, 'a.com');
});

test('legacy empty-state copy is preserved', () => {
  assert.strictEqual(SECRET_EMPTY_STATE, 'No encrypted secrets stored.');
  assert.strictEqual(CREDENTIAL_EMPTY_STATE, 'No account credentials stored.');
});

import { isSwaggerEnabled, parseTrustProxy } from './http.config';

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', 1],
    ['2', 2],
    ['true', true],
    ['loopback', 'loopback'],
  ])('%p → %p', (input, expected) => {
    expect(parseTrustProxy(input)).toBe(expected);
  });
});

describe('isSwaggerEnabled', () => {
  it('habilita fora de produção', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isSwaggerEnabled({})).toBe(true);
  });

  it('desabilita em produção, salvo SWAGGER_ENABLED=true', () => {
    expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'false' })).toBe(false);
    expect(isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(true);
  });
});

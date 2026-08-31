import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chooseTransport } from '../src/client/transport.ts'

test('a production build talks to a host by default', () => {
  // The default is the real thing. A default that quietly invents data is how a
  // host-served page ran on seeded names for two days while two separate checks
  // — assets reachable, RPC answering — both passed.
  assert.equal(chooseTransport('', false), 'rpc')
})

test('a dev build uses the fake, because there is no host behind the dev server', () => {
  // Not a preference: `vite dev` serves the page from an origin with nothing
  // listening on the RPC paths, so the real client would have nothing to talk to.
  assert.equal(chooseTransport('', true), 'fake')
})

test('an explicit request wins in both directions', () => {
  // Both overrides are real workflows: developing against a live host with Vite
  // proxying, and opening the host-served build on seeded data to look at the
  // interface without touching a model.
  assert.equal(chooseTransport('?transport=rpc', true), 'rpc')
  assert.equal(chooseTransport('?transport=fake', false), 'fake')
})

test('an unrecognised value falls back rather than guessing', () => {
  assert.equal(chooseTransport('?transport=grpc', false), 'rpc')
  assert.equal(chooseTransport('?transport=', true), 'fake')
})

test('the parameter is found among others, and only that parameter', () => {
  assert.equal(chooseTransport('?chat=7&transport=fake&x=1', false), 'fake')
  assert.equal(chooseTransport('?mytransport=fake', false), 'rpc')
})

import { describe, expect, it } from 'vitest'
import { parseSsoGateAction } from '../src/sso-gate-window.ts'

const SCHEME = 'dsh-sso-gate:'

describe('sso gate window action parsing', () => {
  it('accepts exactly the sign-in action without parameters', () => {
    expect(parseSsoGateAction(`${SCHEME}//sign-in`)).toEqual({ action: 'sign-in' })
  })

  it('rejects every other origin, path, query, or credential spelling', () => {
    expect(parseSsoGateAction('https://portal.example/sign-in')).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//quit`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in?repeat=1`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//user:pw@sign-in`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in:8080`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in/extra`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in#fragment`)).toBeUndefined()
    expect(parseSsoGateAction('not a url')).toBeUndefined()
    expect(parseSsoGateAction('about:blank')).toBeUndefined()
  })
})

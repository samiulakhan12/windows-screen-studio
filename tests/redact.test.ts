import { describe, expect, it } from 'vitest'
import { redactLine } from '../src/shared/diagnostics/redact'

const WIN_ROOTS = { userData: 'C:\\Users\\John Smith\\AppData\\Roaming\\Flown', projects: 'C:\\Users\\John Smith\\Videos\\Flown', app: 'C:\\Program Files\\Flown\\resources' }
const POSIX_ROOTS = { userData: '/home/jsmith/.config/Flown', projects: '/home/jsmith/Videos/Flown' }

describe('redactLine', () => {
  it('keeps paths inside the app folders relative to them', () => {
    expect(redactLine('Wrote C:\\Users\\John Smith\\AppData\\Roaming\\Flown\\logs\\main.log', WIN_ROOTS)).toBe('Wrote <userData>\\logs\\main.log')
    expect(redactLine('open c:/users/john smith/videos/flown/rec-1/screen.mp4 ok', WIN_ROOTS)).toBe('open <projects>/rec-1/screen.mp4 ok')
    expect(redactLine('read /home/jsmith/Videos/Flown/rec-2/project.json', POSIX_ROOTS)).toBe('read <projects>/rec-2/project.json')
  })

  it('does not treat a longer folder name as the root', () => {
    expect(redactLine('C:\\Users\\John Smith\\Videos\\Flown2\\x.mp4', WIN_ROOTS)).toBe('<path>')
  })

  it('hides every other absolute path, names with spaces included', () => {
    const out = redactLine('Could not save "C:\\Users\\John Smith\\Desktop\\demo.mp4" (EBUSY)', WIN_ROOTS)
    expect(out).toBe('Could not save "<path>" (EBUSY)')
    expect(out).not.toMatch(/John|Smith/)
    expect(redactLine('Moved D:\\Work\\Jane Doe files\\a.mp4 away')).not.toMatch(/Jane|Doe/)
    expect(redactLine('share \\\\server\\Jane Doe\\x.mp4 failed')).not.toMatch(/Jane|server/)
    expect(redactLine('at /home/jsmith/secret/file.txt:3')).toBe('at <path>')
    expect(redactLine('url file:///C:/Users/jsmith/x.png and file:///home/jsmith/y.png')).not.toMatch(/jsmith/)
  })

  it('keeps web addresses and plain text', () => {
    expect(redactLine('GET https://example.com/v1/models 200')).toBe('GET https://example.com/v1/models 200')
    expect(redactLine('export: 120 frames 1920x1080 at 60 fps, 3.2 MB/s')).toBe('export: 120 frames 1920x1080 at 60 fps, 3.2 MB/s')
  })

  it('hides keys, tokens and e-mail addresses', () => {
    expect(redactLine('key sk-proj-abcdefghijklmnopqrstuvwxyz123456')).toBe('key <secret>')
    expect(redactLine('anthropic sk-ant-api03-abcdefghijklmnop_QRS')).toBe('anthropic <secret>')
    expect(redactLine('gemini AIzaSyA1234567890abcdefghijklmnop')).toBe('gemini <secret>')
    expect(redactLine('Authorization: Bearer abc.def-123456789')).toBe('Authorization: Bearer <secret>')
    expect(redactLine('header bearer abcdefgh12345678')).toBe('header bearer <secret>')
    expect(redactLine('url ?key=hello123&x=1')).toBe('url ?key=<secret>&x=1')
    expect(redactLine('{"api_key": "abc123"}')).toBe('{"api_key": "<secret>"}')
    expect(redactLine('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')).toBe('jwt <secret>')
    expect(redactLine('sha 3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed')).toBe('sha <secret>')
    expect(redactLine('mail jane.doe@example.org now')).toBe('mail <email> now')
  })
})

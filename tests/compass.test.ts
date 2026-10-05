import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headingFromEuler } from '../src/nav/compass.ts'

const near = (a: number, b: number, tol = 1) => {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180)
  assert.ok(d <= tol, `${a} vs ${b}`)
}

test('平放：顶部朝向 = 360 - alpha', () => {
  near(headingFromEuler(0, 0, 0), 0)
  near(headingFromEuler(90, 0, 0), 270)   // 逆时针转 90° → 朝西
  near(headingFromEuler(270, 10, -5), 90)  // 朝东
})

test('竖着拿：倾斜补偿后为摄像头朝向', () => {
  near(headingFromEuler(0, 90, 0), 0)
  near(headingFromEuler(90, 90, 0), 270)
  near(headingFromEuler(180, 80, 0), 180)
  near(headingFromEuler(270, 70, 0), 90)
})

test('结果始终在 0..360 且不为 NaN', () => {
  for (let a = 0; a < 360; a += 30) for (let b = -90; b <= 90; b += 15) for (let g = -60; g <= 60; g += 30) {
    const h = headingFromEuler(a, b, g)
    assert.ok(Number.isFinite(h) && h >= 0 && h < 360, `${a},${b},${g} → ${h}`)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePois } from '../src/amap/api.ts'

test('解析 v5 POI 的 business / indoor / navi 字段', () => {
  const pois = parsePois([
    {
      name: '某某火锅(国贸店)', id: 'B0FFA', location: '116.460,39.909', type: '餐饮服务;中餐厅;火锅店',
      adname: '朝阳区', address: '建国门外大街1号', distance: '230',
      business: { rating: '4.6', cost: '128.00', opentime_today: '10:00-22:00', tel: '010-1234', business_area: '国贸' },
      indoor: { indoor_map: '1', cpid: 'B000', floor: '3', truefloor: 'F3' },
      navi: { entr_location: '116.4605,39.9092' },
    },
    { name: '国贸站', location: '116.461,39.908', indoor: { floor: '-2' }, business: { rating: '' } },
    { name: '坏数据', location: '' },
  ])
  assert.equal(pois.length, 2)
  const a = pois[0]
  assert.equal(a.rating, 4.6)
  assert.equal(a.cost, 128)
  assert.equal(a.floor, 'F3')
  assert.equal(a.openToday, '10:00-22:00')
  assert.equal(a.area, '国贸')
  assert.equal(a.distance, 230)
  assert.deepEqual(a.entrance, [116.4605, 39.9092])
  const b = pois[1]
  assert.equal(b.rating, undefined)
  assert.equal(b.floor, 'B2', '只有楼层序号时转换为 B2')
  assert.equal(b.entrance, undefined)
})

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

import { floorFromAddress } from '../src/amap/api.ts'

test('从地址提取楼层', () => {
  const cases: [string, string | undefined][] = [
    ['北京城区南三里屯路1号通盈中心洲际酒店3层', 'F3'],
    ['北京三里屯通盈中心洲际酒店一层', 'F1'],
    ['太古里南区B1层S1-15', 'B1'],
    ['国贸商城地下一层', 'B1'],
    ['某大厦负二楼', 'B2'],
    ['SOHO 5F 506', 'F5'],
    ['某商场十二层', 'F12'],
    ['朝阳区工体北路8号', undefined],
    ['楼梯旁', undefined],
    ['1号楼', undefined],        // 楼栋号，不是楼层
    ['望京SOHO 3号楼5层', 'F5'],
  ]
  for (const [addr, want] of cases) assert.equal(floorFromAddress(addr), want, addr)
})

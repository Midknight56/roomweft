import { describe, expect, it } from 'vitest';
import { NeuronLedger } from '../../src/ai/ledger';
import { asD1, freshD1, LEDGER_SQL } from './d1-fake';
const now=()=>Date.UTC(2026,10,6,23,59);
describe('neuron ledger',()=>{
  it('reserves 45 then settles the actual cost',async()=>{
    const db=freshD1(LEDGER_SQL), ledger=new NeuronLedger(asD1(db),now);
    const id=await ledger.reserve();
    expect(id).toBe(1);
    expect(db.sqlite.prepare('SELECT app,day,neurons FROM ai_calls').get()).toMatchObject({app:'roomweft',day:'2026-11-06',neurons:45});
    expect(await ledger.remaining()).toBe(1155);
    await ledger.settle(id!,26.065);
    expect(db.sqlite.prepare('SELECT neurons FROM ai_calls').get()).toMatchObject({neurons:26.065});
    await ledger.settle(id!,NaN);
    expect(await ledger.remaining()).toBeCloseTo(1173.935);
  });
  it.each([['roomweft',1180],['another-app',9460]])('refuses a reservation at %s spend %s',async(app,spend)=>{
    const db=freshD1(LEDGER_SQL);
    db.sqlite.prepare('INSERT INTO ai_calls (app,day,neurons) VALUES (?,?,?)').run(app,'2026-11-06',spend);
    const ledger=new NeuronLedger(asD1(db),now);
    expect(await ledger.reserve()).toBeNull();
    expect(await ledger.remaining()).toBe(app==='roomweft'?20:40);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_calls').get()).toMatchObject({n:1});
  });
  it('allows exactly the boundary and ignores older days',async()=>{
    const db=freshD1(LEDGER_SQL);
    db.sqlite.exec("INSERT INTO ai_calls (app,day,neurons) VALUES ('roomweft','2026-11-06',1155),('roomweft','2026-11-05',10000)");
    const ledger=new NeuronLedger(asD1(db),now);
    expect(await ledger.reserve()).not.toBeNull();
    expect(await ledger.reserve()).toBeNull();
    expect(await ledger.remaining()).toBe(0);
    expect(await new NeuronLedger(asD1(db),()=>now()+60000).reserve()).not.toBeNull();
  });
  it('fails closed on database errors and retains uncertain holds',async()=>{
    const db=freshD1(LEDGER_SQL), ledger=new NeuronLedger(asD1(db),now);
    const id=await ledger.reserve(); db.broken=true;
    expect(await ledger.reserve()).toBeNull(); expect(await ledger.remaining()).toBe(0);
    await ledger.settle(id!,1); db.broken=false;
    expect(db.sqlite.prepare('SELECT neurons FROM ai_calls').get()).toMatchObject({neurons:45});
  });
  it('grants at most 26 simultaneous holds without exceeding the app cap',async()=>{
    const db=freshD1(LEDGER_SQL),ledger=new NeuronLedger(asD1(db),now);
    const ids=await Promise.all(Array.from({length:30},()=>ledger.reserve()));
    expect(ids.filter(id=>id!==null)).toHaveLength(26);
    expect(db.sqlite.prepare('SELECT SUM(neurons) AS n FROM ai_calls').get()).toMatchObject({n:1170});
  });
});

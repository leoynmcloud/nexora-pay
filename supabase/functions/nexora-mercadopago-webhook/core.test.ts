import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processMercadoPagoPaymentWebhook } from './core.ts';

function makeAdmin(paymentAmount=12.34,paymentStatus='approved',duplicateStatus?:string) {
  const calls: Array<{name:string;args:any}> = [];
  const operation = { id:'op-1',transaction_id:'tx-1',business_id:'biz-1',owner_id:'owner-1',acquirer_id:'acq-1',
    provider_code:'mercadopago_production',environment:'production',external_reference:'NX-REQUEST-1',provider_transaction_id:'998877' };
  const attempt = { id:'attempt-1',transaction_id:'tx-1',business_id:'biz-1',owner_id:'owner-1',acquirer_id:'acq-1',
    provider_operation_id:'op-1',provider_transaction_id:'998877',environment:'production',external_reference:'NX-REQUEST-1',status:'processing' };
  const transaction = { id:'tx-1',owner_id:'owner-1',business_id:'biz-1',amount:12.34,test_mode:false,kind:'payment',acquirer_id:'acq-1',status:'pending' };
  const records: Record<string,any> = {nexora_provider_payment_operations:operation,nexora_payment_attempts:attempt,nexora_transactions:transaction};
  const admin = {
    from(table:string) {
      let filters: Record<string,unknown> = {};
      const query:any = {
        select() { return query; },
        eq(key:string,value:unknown) { filters[key]=value; return query; },
        maybeSingle: async () => {
          if(table==='nexora_provider_payment_status_events'&&duplicateStatus) return {data:{
            provider_event_type:'payment.updated',provider_operation_id:'op-1',transaction_id:'tx-1',
            provider_transaction_id:'998877',normalized_status:duplicateStatus,
          },error:null};
          const row=records[table];
          if (!row || Object.entries(filters).some(([key,value]) => row[key]!==value)) return {data:null,error:null};
          return {data:row,error:null};
        },
        insert(row:any) {
          assert.equal(table,'nexora_provider_payment_status_events');
          calls.push({name:'insert_status_event',args:row});
          if(duplicateStatus) return {select() {return this;},maybeSingle:async()=>({data:null,error:{code:'23505'}})};
          return { select() { return this; }, maybeSingle: async () => ({data:{id:'event-row-1'},error:null}) };
        },
      };
      return query;
    },
    async rpc(name:string,args:any) { calls.push({name,args}); return {data:null,error:null}; },
  };
  const fetchImpl:typeof fetch = async () => Response.json({
    id:998877,external_reference:'NX-REQUEST-1',transaction_amount:paymentAmount,
    status:paymentStatus,point_of_interaction:{transaction_data:{qr_code:'pix-copy',qr_code_base64:'cXI='}},
  });
  return {admin,calls,fetchImpl};
}

describe('Mercado Pago webhook verified payment processing',()=>{
  it('credits only the pending ledger after provider identity, amount, and status are verified',async()=>{
    const {admin,calls,fetchImpl}=makeAdmin();
    const result=await processMercadoPagoPaymentWebhook(admin,{
      eventId:'mp-event-1',eventType:'payment.updated',providerTransactionId:'998877',accessToken:'APP_USR-secret',
    },fetchImpl);
    assert.deepEqual(result,{outcome:'posted_pending',transactionId:'tx-1'});
    assert.equal(calls.find(call=>call.name==='insert_status_event')?.args.normalized_status,'SUCCEEDED');
    const ledger=calls.find(call=>call.name==='nexora_ledger_post_journal');
    assert.equal(ledger?.args.p_event_code,'payment.received');
    assert.equal(ledger?.args.p_idempotency_key,'provider.payment.succeeded:mercadopago_production:tx-1');
    assert.ok(ledger.args.p_idempotency_key.length<=128);
    assert.deepEqual(ledger?.args.p_entries,[
      {account_code:'provider_clearing',side:'debit',amount_cents:1234},
      {account_code:'merchant_pending',side:'credit',amount_cents:1234},
    ]);
    const confirmation=calls.find(call=>call.name==='nexora_provider_confirm_payment_succeeded')?.args;
    assert.equal(confirmation?.p_provider_code,'mercadopago_production');
    assert.equal(confirmation?.p_provider_event_id,'mp-event-1');
    assert.equal(calls.at(-1)?.name,'nexora_provider_confirm_payment_succeeded');
  });

  it('records non-success states without posting funds',async()=>{
    const {admin,calls,fetchImpl}=makeAdmin(12.34,'pending');
    const result=await processMercadoPagoPaymentWebhook(admin,{
      eventId:'mp-event-pending',eventType:'payment.updated',providerTransactionId:'998877',accessToken:'APP_USR-secret',
    },fetchImpl);
    assert.deepEqual(result,{outcome:'status_recorded',transactionId:'tx-1',status:'PENDING'});
    assert.equal(calls.some(call=>call.name==='nexora_ledger_post_journal'),false);
    assert.equal(calls.some(call=>call.name==='nexora_provider_confirm_payment_succeeded'),false);
  });

  it('persists provider rejection and cancellation as terminal states without crediting funds',async()=>{
    for (const [providerStatus,normalizedStatus] of [['rejected','FAILED'],['cancelled','CANCELED']] as const) {
      const {admin,calls,fetchImpl}=makeAdmin(12.34,providerStatus);
      const result=await processMercadoPagoPaymentWebhook(admin,{
        eventId:`mp-event-${providerStatus}`,eventType:'payment.updated',providerTransactionId:'998877',accessToken:'APP_USR-secret',
      },fetchImpl);
      assert.deepEqual(result,{outcome:'status_recorded',transactionId:'tx-1',status:normalizedStatus});
      const save=calls.find(call=>call.name==='nexora_provider_save_charge_result');
      assert.equal(save?.args.p_normalized_status,normalizedStatus);
      assert.equal(calls.some(call=>call.name==='nexora_ledger_post_journal'),false);
      assert.equal(calls.some(call=>call.name==='nexora_provider_confirm_payment_succeeded'),false);
    }
  });

  it('rejects mismatched amounts before status history or ledger writes',async()=>{
    const {admin,calls,fetchImpl}=makeAdmin(99,'approved');
    await assert.rejects(processMercadoPagoPaymentWebhook(admin,{
      eventId:'mp-event-bad',eventType:'payment.updated',providerTransactionId:'998877',accessToken:'APP_USR-secret',
    },fetchImpl),/amount_mismatch/);
    assert.equal(calls.length,0);
  });

  it('does not reinterpret a duplicate immutable pending event as a later success',async()=>{
    const {admin,calls,fetchImpl}=makeAdmin(12.34,'approved','PENDING');
    const result=await processMercadoPagoPaymentWebhook(admin,{
      eventId:'mp-event-same',eventType:'payment.updated',providerTransactionId:'998877',accessToken:'APP_USR-secret',
    },fetchImpl);
    assert.deepEqual(result,{outcome:'status_recorded',transactionId:'tx-1',status:'PENDING'});
    assert.equal(calls.some(call=>call.name==='nexora_ledger_post_journal'),false);
  });
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS"};
const out=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return out({error:"Method not allowed."},405);
 try{
  const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();
  if(!token)return out({error:"Authentication required."},401);
  const admin=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await admin.auth.getUser(token); if(auth.error||!auth.data.user)return out({error:"Invalid session."},401);
  const user=auth.data.user;
  const client=createClient(URL,ANON,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
  const body=await req.json(); const action=String(body.action||"");
  const perm=async(kind:"view"|"create"|"edit"|"approve"|"export")=>{
    const map={view:"portal_management_can_view",create:"portal_management_can_create",edit:"portal_management_can_edit",approve:"portal_management_has_permission",export:"portal_management_can_view"} as const;
    const args=kind==="approve"?{p_module:"Funding",p_permission:"approve"}:{p_module:"Funding"};
    const {data,error}=await client.rpc(map[kind],args);
    return !error&&data===true;
  };
  const need=async(kind:"view"|"create"|"edit"|"approve"|"export")=>await perm(kind);
  const audit=async(type:string,id:number,verb:string,before:unknown,after:unknown)=>{
    const {error}=await admin.from("funding_audit_log").insert({entity_type:type,entity_id:id,action:verb,before_data:before??null,after_data:after??null,actor_id:user.id});
    if(error)console.error("Funding audit log failed",error);
  };
  const listTables:Record<string,string>={parties:"funding_parties",opportunities:"funding_opportunities",commitments:"funding_commitments",receipts:"funding_receipts",settlements:"funding_settlements",allocations:"funding_project_allocations",ledger:"funding_liability_ledger"};
  if(action==="dashboard"){
    if(!(await need("view")))return out({error:"Funding view permission required."},403);
    const names=Object.values(listTables);
    const results=await Promise.all(names.map(t=>admin.from(t).select("*",{count:"exact",head:true})));
    if(results.some(x=>x.error))throw new Error("Unable to load funding dashboard.");
    const [open,committed,received,settled]=await Promise.all([
      admin.from("funding_opportunities").select("id,target_amount,currency_code,status").in("status",["open","approved"]),
      admin.from("funding_commitments").select("id,principal_amount,currency_code,status,maturity_date").in("status",["committed","funds_pending","funded","matured"]),
      admin.from("funding_liability_ledger").select("entry_type,amount,currency_code"),
      admin.from("funding_settlements").select("id,principal_paid,return_paid,status,paid_on").eq("status","paid")
    ]);
    if(open.error||committed.error||received.error||settled.error)throw new Error("Unable to load funding summary.");
    return out({success:true,counts:Object.fromEntries(names.map((n,i)=>[n,results[i].count||0])),opportunities:open.data||[],commitments:committed.data||[],ledger:received.data||[],settlements:settled.data||[]});
  }
  if(action==="list"){
    if(!(await need("view")))return out({error:"Funding view permission required."},403);
    const table=listTables[String(body.resource||"")]; if(!table)return out({error:"Unknown funding resource."},400);
    const {data,error}=await admin.from(table).select("*").order("created_at",{ascending:false}).limit(500);
    if(error)throw error; return out({success:true,records:data||[]});
  }
  if(action==="create_party"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const name=String(body.legal_name||"").trim(); if(name.length<2||name.length>180)return out({error:"Valid legal name required."},400);
    const {data,error}=await admin.from("funding_parties").insert({legal_name:name,contact_name:String(body.contact_name||"").trim()||null,email:String(body.email||"").trim()||null,phone:String(body.phone||"").trim()||null,party_type:body.party_type==="company"?"company":"individual",kyc_status:"not_started",status:"draft",notes:String(body.notes||"").slice(0,2000)||null}).select("*").single();
    if(error)throw error; await audit("party",data.id,"created",null,data); return out({success:true,record:data});
  }
  if(action==="set_party_status"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id),status=String(body.status||"");
    if(!Number.isSafeInteger(id)||!["active","suspended","closed"].includes(status))return out({error:"Valid funder and status required."},400);
    const {data:before}=await admin.from("funding_parties").select("*").eq("id",id).maybeSingle();
    if(!before)return out({error:"Funder not found."},404);
    if(status==="active"&&before.kyc_status!=="verified")return out({error:"KYC must be verified before activating a funder."},409);
    const {data,error}=await admin.from("funding_parties").update({status,updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
    if(error)throw error;await audit("party",id,"status_"+status,before,data);return out({success:true,record:data});
  }
  if(action==="set_kyc"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id),status=String(body.kyc_status||"");
    if(!Number.isSafeInteger(id)||!["pending","verified","rejected","expired"].includes(status))return out({error:"Valid funder and KYC status required."},400);
    const {data:before}=await admin.from("funding_parties").select("*").eq("id",id).maybeSingle(); if(!before)return out({error:"Funder not found."},404);
    const {data,error}=await admin.from("funding_parties").update({kyc_status:status,kyc_reference:String(body.kyc_reference||"").trim()||before.kyc_reference,updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
    if(error)throw error; await audit("party",id,"kyc_"+status,before,data); return out({success:true,record:data});
  }
  if(action==="create_opportunity"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const title=String(body.title||"").trim(),amount=Number(body.target_amount),ref=String(body.reference_code||"").trim();
    if(title.length<3||title.length>180||!ref||ref.length>60||!Number.isFinite(amount)||amount<=0)return out({error:"Valid title, unique reference and positive target amount required."},400);
    const {data,error}=await admin.from("funding_opportunities").insert({reference_code:ref,title,description:String(body.description||"").slice(0,4000)||null,project_id:body.project_id?Number(body.project_id):null,target_amount:amount,currency_code:String(body.currency_code||"KES").toUpperCase(),proposed_return_rate:body.proposed_return_rate===undefined?null:Number(body.proposed_return_rate),term_days:body.term_days?Number(body.term_days):null,opens_on:body.opens_on||null,closes_on:body.closes_on||null,status:"draft",created_by:user.id}).select("*").single();
    if(error)throw error; await audit("opportunity",data.id,"created",null,data); return out({success:true,record:data});
  }
  if(action==="submit_opportunity"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id); const {data:before}=await admin.from("funding_opportunities").select("*").eq("id",id).maybeSingle();
    if(!before||before.status!=="draft")return out({error:"Only draft opportunities can be submitted."},409);
    const {data,error}=await admin.from("funding_opportunities").update({status:"pending_approval",updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
    if(error)throw error; await audit("opportunity",id,"submitted_for_approval",before,data); return out({success:true,record:data});
  }
  if(action==="approve_legal"||action==="approve_finance"){
    if(!(await need("approve")))return out({error:"Funding approval permission required."},403);
    const id=Number(body.id),reference=String(body.approval_reference||"").trim();
    if(!Number.isSafeInteger(id)||!reference||reference.length>180)return out({error:"Opportunity and approval reference are required."},400);
    const {data:before}=await admin.from("funding_opportunities").select("*").eq("id",id).maybeSingle();
    if(!before||before.status!=="pending_approval")return out({error:"Opportunity is not awaiting approval."},409);
    const legal=action==="approve_legal";
    const actorField=legal?"legal_approved_by":"finance_approved_by";
    const refField=legal?"legal_approval_reference":"finance_approval_reference";
    const atField=legal?"legal_approved_at":"finance_approved_at";
    if(before[actorField])return out({error:"This approval has already been recorded."},409);
    const otherActor=legal?before.finance_approved_by:before.legal_approved_by;
    if(otherActor===user.id)return out({error:"Legal and finance approvals must be completed by different authorised users."},409);
    const patch:any={[actorField]:user.id,[refField]:reference,[atField]:new Date().toISOString(),updated_at:new Date().toISOString()};
    const {data:updated,error}=await admin.from("funding_opportunities").update(patch).eq("id",id).eq("status","pending_approval").is(actorField,null).select("*").maybeSingle();
    if(error)throw error;if(!updated)return out({error:"Approval changed concurrently; refresh and retry."},409);
    let result=updated;
    if(updated.legal_approved_by&&updated.finance_approved_by&&updated.legal_approved_by!==updated.finance_approved_by){
      const {data:approved,error:approveError}=await admin.from("funding_opportunities").update({status:"approved",approved_by:user.id,approved_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).eq("status","pending_approval").not("legal_approved_by","is",null).not("finance_approved_by","is",null).select("*").maybeSingle();
      if(approveError)throw approveError;if(approved)result=approved;
    }
    await audit("opportunity",id,legal?"legal_approval_recorded":"finance_approval_recorded",before,result);
    return out({success:true,record:result});
  }
  if(action==="approve_opportunity")return out({error:"Use separate approve_legal and approve_finance actions. Different authorised users are required."},400);
  if(action==="open_opportunity"||action==="pause_opportunity"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id);const {data:before}=await admin.from("funding_opportunities").select("*").eq("id",id).maybeSingle();
    if(!before||!["approved","open","paused"].includes(before.status))return out({error:"Opportunity must first receive both approvals."},409);
    const status=action==="open_opportunity"?"open":"paused";
    const {data,error}=await admin.from("funding_opportunities").update({status,updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
    if(error)throw error;await audit("opportunity",id,status,before,data);return out({success:true,record:data});
  }
  if(action==="create_commitment"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const opportunity=Number(body.opportunity_id),funder=Number(body.funder_id),principal=Number(body.principal_amount),rate=Number(body.agreed_return_rate),days=Number(body.term_days);
    const [{data:opp},{data:party}]=await Promise.all([admin.from("funding_opportunities").select("*").eq("id",opportunity).maybeSingle(),admin.from("funding_parties").select("*").eq("id",funder).maybeSingle()]);
    if(!opp||opp.status!=="open")return out({error:"Only open approved opportunities accept commitments."},409);
    if(!party||party.kyc_status!=="verified"||party.status!=="active")return out({error:"Funder must be active with verified KYC."},409);
    if(!Number.isFinite(principal)||principal<=0||!Number.isFinite(rate)||rate<0||!Number.isInteger(days)||days<1||days>3650)return out({error:"Valid principal, return rate and term are required."},400);
    const {data:prior}=await admin.from("funding_commitments").select("principal_amount").eq("opportunity_id",opportunity).not("status","in",'("(cancelled)")');
    const already=(prior||[]).reduce((s,x)=>s+Number(x.principal_amount),0);
    if(already+principal>Number(opp.target_amount))return out({error:"Total commitments cannot exceed the opportunity target amount."},400);
    const agreement=String(body.agreement_reference||"").trim(),signed=String(body.signed_at||"").trim();
    const signedAt=agreement&&signed?new Date(signed):null;
    const isSigned=!!(agreement&&signedAt&&!Number.isNaN(signedAt.getTime()));
    const maturity=isSigned?new Date(signedAt!.getTime()+days*86400000).toISOString().slice(0,10):null;
    const {data,error}=await admin.from("funding_commitments").insert({opportunity_id:opportunity,funder_id:funder,principal_amount:principal,currency_code:opp.currency_code,agreed_return_rate:rate,term_days:days,status:isSigned?"committed":"pending_agreement",agreement_reference:isSigned?agreement:null,signed_at:isSigned?signedAt!.toISOString():null,terms_locked_at:isSigned?new Date().toISOString():null,maturity_date:maturity}).select("*").single();
    if(error)throw error;await audit("commitment",data.id,"created",null,data);return out({success:true,record:data});
  }
  if(action==="record_receipt"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const cid=Number(body.commitment_id),amount=Number(body.amount);if(!cid||!Number.isFinite(amount)||amount<=0)return out({error:"Commitment and positive receipt amount required."},400);
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",cid).maybeSingle();
    if(!commit||!["committed","funds_pending","funded"].includes(commit.status))return out({error:"A signed commitment is required before recording funds."},409);
    const {data:existingReceipts}=await admin.from("funding_receipts").select("amount").eq("commitment_id",cid).neq("verification_status","rejected");
    const receivedSoFar=(existingReceipts||[]).reduce((s,x)=>s+Number(x.amount),0);
    if(receivedSoFar+amount>Number(commit.principal_amount))return out({error:"Receipts cannot exceed the signed commitment principal."},409);
    const {data:receipt,error}=await admin.from("funding_receipts").insert({commitment_id:cid,amount,currency_code:commit.currency_code,received_on:body.received_on||new Date().toISOString().slice(0,10),payment_method:String(body.payment_method||"").slice(0,80)||null,external_reference:String(body.external_reference||"").slice(0,160)||null,notes:String(body.notes||"").slice(0,1000)||null,verification_status:"pending",created_by:user.id}).select("*").single();
    if(error)throw error;await audit("receipt",receipt.id,"recorded_pending_verification",null,receipt);return out({success:true,record:receipt});
  }
  if(action==="verify_receipt"){
    if(!(await need("approve")))return out({error:"Funding approval permission required."},403);
    const id=Number(body.id);const {data:before}=await admin.from("funding_receipts").select("*").eq("id",id).maybeSingle();
    if(!before||before.verification_status!=="pending")return out({error:"Receipt is not pending verification."},409);
    if(body.decision==="reject"){
      const {data,error}=await admin.from("funding_receipts").update({verification_status:"rejected",verified_by:user.id,verified_at:new Date().toISOString()}).eq("id",id).select("*").single();
      if(error)throw error;await audit("receipt",id,"rejected",before,data);return out({success:true,record:data});
    }
    const {data:duplicate}=await admin.from("funding_liability_ledger").select("id").eq("receipt_id",id).maybeSingle();
    if(duplicate)return out({error:"Receipt already posted to the liability ledger."},409);
    const {data:receipt,error}=await admin.from("funding_receipts").update({verification_status:"verified",verified_by:user.id,verified_at:new Date().toISOString()}).eq("id",id).eq("verification_status","pending").select("*").maybeSingle();
    if(error)throw error;if(!receipt)return out({error:"Receipt changed; refresh and retry."},409);
    const {error:ledgerError}=await admin.from("funding_liability_ledger").insert({commitment_id:receipt.commitment_id,receipt_id:id,entry_type:"principal_received",amount:receipt.amount,currency_code:receipt.currency_code,effective_date:receipt.received_on,reference:receipt.external_reference,created_by:user.id});
    if(ledgerError)throw ledgerError;
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",receipt.commitment_id).single();
    await admin.from("funding_commitments").update({status:"funded",updated_at:new Date().toISOString()}).eq("id",receipt.commitment_id);
    await audit("receipt",id,"verified_and_posted",before,receipt);return out({success:true,record:receipt,commitment:commit});
  }
  if(action==="allocate_project"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const cid=Number(body.commitment_id),pid=Number(body.project_id),amount=Number(body.allocated_amount);
    if(!cid||!pid||!Number.isFinite(amount)||amount<=0)return out({error:"Commitment, project and positive allocation required."},400);
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",cid).maybeSingle();
    if(!commit||!["funded","matured"].includes(commit.status))return out({error:"Only funded commitments can be allocated."},409);
    const {data:received}=await admin.from("funding_liability_ledger").select("amount").eq("commitment_id",cid).eq("entry_type","principal_received");
    const {data:allocated}=await admin.from("funding_project_allocations").select("allocated_amount").eq("commitment_id",cid);
    const total=(received||[]).reduce((s,x)=>s+Number(x.amount),0),used=(allocated||[]).reduce((s,x)=>s+Number(x.allocated_amount),0);
    if(used+amount>total)return out({error:"Allocation exceeds verified funding received."},409);
    const {data,error}=await admin.from("funding_project_allocations").insert({commitment_id:cid,project_id:pid,allocated_amount:amount,notes:String(body.notes||"").slice(0,1000)||null,created_by:user.id}).select("*").single();
    if(error)throw error;await audit("allocation",data.id,"created",null,data);return out({success:true,record:data});
  }
  if(action==="create_settlement"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const cid=Number(body.commitment_id),principal=Number(body.principal_paid),ret=Number(body.return_paid);
    if(!cid||!Number.isFinite(principal)||principal<0||!Number.isFinite(ret)||ret<0||principal+ret<=0)return out({error:"Valid principal and return amounts required."},400);
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",cid).maybeSingle();
    if(!commit||!["funded","matured"].includes(commit.status))return out({error:"Only funded commitments can be settled."},409);
    const {data:ledger}=await admin.from("funding_liability_ledger").select("entry_type,amount").eq("commitment_id",cid);
    const received=(ledger||[]).filter(x=>x.entry_type==="principal_received").reduce((s,x)=>s+Number(x.amount),0);
    const principalPaid=(ledger||[]).filter(x=>x.entry_type==="principal_repaid").reduce((s,x)=>s+Number(x.amount),0);
    if(principal>received-principalPaid)return out({error:"Principal repayment exceeds outstanding principal."},409);
    const {data,error}=await admin.from("funding_settlements").insert({commitment_id:cid,principal_paid:principal,return_paid:ret,status:"pending_approval",created_by:user.id}).select("*").single();
    if(error)throw error;await audit("settlement",data.id,"submitted_for_approval",null,data);return out({success:true,record:data});
  }
  if(action==="approve_settlement"){
    if(!(await need("approve")))return out({error:"Funding approval permission required."},403);
    const id=Number(body.id);const {data:before}=await admin.from("funding_settlements").select("*").eq("id",id).maybeSingle();
    if(!before||before.status!=="pending_approval")return out({error:"Settlement is not awaiting approval."},409);
    if(before.created_by===user.id)return out({error:"The person who created a settlement cannot approve it."},403);
    const {data,error}=await admin.from("funding_settlements").update({status:"approved",approved_by:user.id,approved_at:new Date().toISOString()}).eq("id",id).eq("status","pending_approval").select("*").maybeSingle();
    if(error)throw error;if(!data)return out({error:"Settlement changed; refresh and retry."},409);
    await audit("settlement",id,"approved",before,data);return out({success:true,record:data});
  }
  if(action==="mark_settlement_paid"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id),ref=String(body.payment_reference||"").trim(),paidOn=String(body.paid_on||new Date().toISOString().slice(0,10));
    if(!ref)return out({error:"Payment reference is required."},400);
    const {data:before}=await admin.from("funding_settlements").select("*").eq("id",id).maybeSingle();
    if(!before||before.status!=="approved")return out({error:"Only approved settlements can be marked paid."},409);
    if(before.approved_by===user.id)return out({error:"The settlement approver cannot record the payment. A second authorised user is required."},403);
    const {data:paid,error}=await admin.from("funding_settlements").update({status:"paid",payment_reference:ref,paid_on:paidOn}).eq("id",id).eq("status","approved").select("*").maybeSingle();
    if(error)throw error;if(!paid)return out({error:"Settlement changed; refresh and retry."},409);
    const {data:existing}=await admin.from("funding_liability_ledger").select("id").eq("settlement_id",id).maybeSingle();
    if(existing)return out({error:"Settlement ledger entries already exist; contact an administrator."},409);
    const entries=[];if(Number(paid.principal_paid)>0)entries.push({commitment_id:paid.commitment_id,settlement_id:id,entry_type:"principal_repaid",amount:paid.principal_paid,effective_date:paidOn,reference:ref,created_by:user.id});
    if(Number(paid.return_paid)>0)entries.push({commitment_id:paid.commitment_id,settlement_id:id,entry_type:"return_paid",amount:paid.return_paid,effective_date:paidOn,reference:ref,created_by:user.id});
    if(entries.length){const {error:le}=await admin.from("funding_liability_ledger").insert(entries);if(le)throw le;}
    await audit("settlement",id,"paid_and_posted",before,paid);return out({success:true,record:paid});
  }
  return out({error:"Unsupported funding action."},400);
 }catch(e){console.error("Funding workflow",e);return out({error:"Funding workflow could not be completed."},500);}
});
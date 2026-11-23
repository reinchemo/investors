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
  const listTables:Record<string,string>={parties:"funding_parties",opportunities:"funding_opportunities",commitments:"funding_commitments",receipts:"funding_receipts",settlements:"funding_settlements",allocations:"funding_project_allocations",ledger:"funding_liability_ledger",documents:"funding_documents"};
  if(action==="investor_express_interest"){
    const {data:portal}=await admin.from("personal_portal_accounts").select("investor_id,account_status").eq("user_id",user.id).maybeSingle();
    if(!portal||portal.account_status!=="active"||!portal.investor_id)return out({error:"An active investor portal account is required."},403);
    const opportunity=Number(body.opportunity_id),principal=Number(body.principal_amount),key=String(body.idempotency_key||"").trim();
    if(!key||key.length>120||!Number.isFinite(principal)||principal<=0)return out({error:"A valid amount and request reference are required."},400);
    const {data:opp}=await admin.from("funding_opportunities").select("*").eq("id",opportunity).maybeSingle();
    const today=new Date().toISOString().slice(0,10);
    if(!opp||opp.status!=="open"||!opp.legal_gate_cleared_at||!opp.terms_approved_at||opp.opens_on&&opp.opens_on>today||opp.closes_on&&opp.closes_on<today)return out({error:"This opportunity is not currently accepting interest."},409);
    if(principal<Number(opp.minimum_commitment)||(opp.maximum_commitment!==null&&principal>Number(opp.maximum_commitment)))return out({error:"Amount is outside the opportunity's approved commitment range."},400);
    const {data:priorKey}=await admin.from("funding_commitments").select("id,status").eq("idempotency_key",key).maybeSingle();
    if(priorKey)return out({success:true,record:priorKey,replayed:true});
    const {data:investor}=await admin.from("investors").select("id,name,email,phone").eq("id",portal.investor_id).is("deleted_at",null).maybeSingle();
    if(!investor)return out({error:"Linked investor record not found."},404);
    let {data:party}=await admin.from("funding_parties").select("*").eq("investor_id",investor.id).maybeSingle();
    if(!party){
      const {data:created,error}=await admin.from("funding_parties").insert({investor_id:investor.id,legal_name:investor.name,contact_name:investor.name,email:investor.email,phone:investor.phone,party_type:"individual",kyc_status:"not_started",status:"draft"}).select("*").single();
      if(error)throw error;party=created;
    }
    const snapshot={opportunity_id:opp.id,reference_code:opp.reference_code,title:opp.title,funding_purpose:opp.funding_purpose,principal_amount:principal,currency_code:opp.currency_code,return_type:opp.return_type,return_rate:Number(opp.proposed_return_rate),day_count_basis:opp.day_count_basis,term_days:Number(opp.term_days),tax_rate:opp.tax_rate,other_deductions:opp.other_deductions,terms_version:opp.terms_version,legal_approval_reference:opp.legal_approval_reference,finance_approval_reference:opp.finance_approval_reference,management_approval_reference:opp.management_approval_reference};
    const {data,error}=await admin.from("funding_commitments").insert({opportunity_id:opp.id,funder_id:party.id,principal_amount:principal,currency_code:opp.currency_code,agreed_return_rate:opp.proposed_return_rate,term_days:opp.term_days,return_type:opp.return_type,day_count_basis:opp.day_count_basis,tax_rate_snapshot:opp.tax_rate,deductions_snapshot:opp.other_deductions,terms_snapshot:snapshot,terms_version:opp.terms_version,status:"interested",idempotency_key:key}).select("*").single();
    if(error)throw error;await audit("commitment",data.id,"investor_interest_submitted",null,data);return out({success:true,record:data,kyc_status:party.kyc_status});
  }
  if(action==="investor_submit_commitment"){
    const {data:portal}=await admin.from("personal_portal_accounts").select("investor_id,account_status").eq("user_id",user.id).maybeSingle();
    if(!portal||portal.account_status!=="active"||!portal.investor_id)return out({error:"An active investor portal account is required."},403);
    const id=Number(body.id);
    const {data:investorParty}=await admin.from("funding_parties").select("id,kyc_status,status").eq("investor_id",portal.investor_id).maybeSingle();
    if(!investorParty||investorParty.kyc_status!=="verified"||investorParty.status!=="active")return out({error:"KYC must be verified and your funder profile active before submitting a commitment."},409);
    const {data:before}=await admin.from("funding_commitments").select("*,funding_opportunities(target_amount,status,minimum_commitment,maximum_commitment)").eq("id",id).eq("funder_id",investorParty.id).maybeSingle();
    if(!before||before.status!=="interested")return out({error:"Interest request not found or already submitted."},409);
    if(before.funding_opportunities?.status!=="open")return out({error:"The funding opportunity is no longer open."},409);
    const {data:prior}=await admin.from("funding_commitments").select("principal_amount").eq("opportunity_id",before.opportunity_id).not("status","in",'("(cancelled,rejected,interested)")');
    const already=(prior||[]).reduce((sum:number,row:any)=>sum+Number(row.principal_amount),0);
    if(already+Number(before.principal_amount)>Number(before.funding_opportunities.target_amount))return out({error:"The remaining approved funding capacity is insufficient."},409);
    const {data,error}=await admin.from("funding_commitments").update({status:"commitment_submitted",updated_at:new Date().toISOString()}).eq("id",id).eq("status","interested").select("*").maybeSingle();
    if(error)throw error;if(!data)return out({error:"Request changed; refresh and retry."},409);
    await audit("commitment",id,"investor_commitment_submitted",before,data);return out({success:true,record:data});
  }
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
    const investorId=body.investor_id?Number(body.investor_id):null;
    if(investorId&&!Number.isSafeInteger(investorId))return out({error:"Invalid linked investor."},400);
    const {data,error}=await admin.from("funding_parties").insert({legal_name:name,contact_name:String(body.contact_name||"").trim()||null,email:String(body.email||"").trim()||null,phone:String(body.phone||"").trim()||null,party_type:body.party_type==="company"?"company":"individual",investor_id:investorId,beneficial_ownership:Array.isArray(body.beneficial_ownership)?body.beneficial_ownership:[],consent_records:Array.isArray(body.consent_records)?body.consent_records:[],kyc_status:"not_started",status:"draft",notes:String(body.notes||"").slice(0,2000)||null}).select("*").single();
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
  if(action==="list_equity_investors"){
    if(!(await need("view")))return out({error:"Funding view permission required."},403);
    const {data,error}=await admin.from("investors").select("id,name,investor_number,email,phone,status").is("deleted_at",null).order("name").limit(1000);
    if(error)throw error;return out({success:true,records:data||[]});
  }
  if(action==="create_document_upload"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const funderId=Number(body.funder_id),filename=String(body.filename||"").replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120),mime=String(body.mime_type||"");
    const size=Number(body.file_size_bytes);
    if(!Number.isSafeInteger(funderId)||!filename||!["application/pdf","image/jpeg","image/png"].includes(mime)||!Number.isSafeInteger(size)||size<1||size>10485760)return out({error:"Only PDF, JPG or PNG documents up to 10 MB are accepted."},400);
    const path=funderId+"/"+crypto.randomUUID()+"-"+filename;
    const {data,error}=await admin.storage.from("funding-private").createSignedUploadUrl(path);
    if(error)throw error;
    const {data:doc,error:docError}=await admin.from("funding_documents").insert({funder_id:funderId,document_type:String(body.document_type||"identity").slice(0,60),object_path:path,original_filename:filename,mime_type:mime,file_size_bytes:size,expiry_date:body.expiry_date||null,uploaded_by:user.id}).select("*").single();
    if(docError)throw docError;
    await audit("document",doc.id,"upload_link_created",null,{...doc,object_path:"[private]"});
    return out({success:true,document:doc,signed_upload:data});
  }
  if(action==="review_document"){
    if(!(await need("approve")))return out({error:"Funding approval permission required."},403);
    const id=Number(body.id),decision=String(body.decision||"");
    if(!Number.isSafeInteger(id)||!["accepted","rejected"].includes(decision))return out({error:"Valid document decision required."},400);
    const {data:before}=await admin.from("funding_documents").select("*").eq("id",id).maybeSingle();
    if(!before||before.review_status!=="pending")return out({error:"Document is not awaiting review."},409);
    const {data,error}=await admin.from("funding_documents").update({review_status:decision,reviewed_by:user.id,reviewed_at:new Date().toISOString(),review_reason:String(body.reason||"").slice(0,1000)||null}).eq("id",id).select("*").single();
    if(error)throw error;await audit("document",id,"review_"+decision,{...before,object_path:"[private]"},{...data,object_path:"[private]"});return out({success:true,record:data});
  }
  if(action==="create_signed_document_url"){
    if(!(await need("view")))return out({error:"Funding view permission required."},403);
    const id=Number(body.id);const {data:doc}=await admin.from("funding_documents").select("*").eq("id",id).maybeSingle();
    if(!doc)return out({error:"Document not found."},404);
    const {data,error}=await admin.storage.from("funding-private").createSignedUrl(doc.object_path,300);
    if(error)throw error;return out({success:true,url:data.signedUrl,expires_in:300});
  }
  if(action==="set_kyc"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id),status=String(body.kyc_status||"");
    if(!Number.isSafeInteger(id)||!["pending","verified","rejected","expired"].includes(status))return out({error:"Valid funder and KYC status required."},400);
    const {data:before}=await admin.from("funding_parties").select("*").eq("id",id).maybeSingle(); if(!before)return out({error:"Funder not found."},404);
    const reason=String(body.reason||"").trim().slice(0,1000)||null;
    const {data,error}=await admin.from("funding_parties").update({kyc_status:status,kyc_reference:String(body.kyc_reference||"").trim()||before.kyc_reference,kyc_reviewed_by:user.id,kyc_reviewed_at:new Date().toISOString(),kyc_decision_reason:reason,rejection_reason:status==="rejected"?reason:null,status:status==="verified"?"active":status==="rejected"?"closed":before.status,updated_at:new Date().toISOString()}).eq("id",id).select("*").single();
    if(error)throw error; await audit("party",id,"kyc_"+status,before,data); return out({success:true,record:data});
  }
  if(action==="create_opportunity"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const title=String(body.title||"").trim(),amount=Number(body.target_amount),ref=String(body.reference_code||"").trim();
    if(title.length<3||title.length>180||!ref||ref.length>60||!Number.isFinite(amount)||amount<=0)return out({error:"Valid title, unique reference and positive target amount required."},400);
    const term=body.term_days===undefined||body.term_days===null||body.term_days===""?120:Number(body.term_days);
    const rate=body.proposed_return_rate===""||body.proposed_return_rate===undefined?null:Number(body.proposed_return_rate);
    const min=body.minimum_commitment===undefined||body.minimum_commitment===""?1:Number(body.minimum_commitment);
    const max=body.maximum_commitment===""||body.maximum_commitment===undefined?null:Number(body.maximum_commitment);
    const tax=body.tax_rate===""||body.tax_rate===undefined?null:Number(body.tax_rate);
    if(!Number.isInteger(term)||term<1||term>3650||!Number.isFinite(min)||min<=0||(max!==null&&(!Number.isFinite(max)||max<min))||(rate!==null&&(!Number.isFinite(rate)||rate<0))||(tax!==null&&(!Number.isFinite(tax)||tax<0||tax>100)))return out({error:"Check tenure, commitment limits, return rate and tax rate."},400);
    const {data,error}=await admin.from("funding_opportunities").insert({reference_code:ref,title,description:String(body.description||"").slice(0,4000)||null,funding_purpose:String(body.funding_purpose||"").slice(0,2000)||null,project_id:body.project_id?Number(body.project_id):null,target_amount:amount,currency_code:String(body.currency_code||"KES").toUpperCase(),minimum_commitment:min,maximum_commitment:max,proposed_return_rate:rate,return_type:body.return_type==="annualised_simple"?"annualised_simple":"fixed_total_period",day_count_basis:["actual_360","30_360"].includes(body.day_count_basis)?body.day_count_basis:"actual_365",term_days:term,opens_on:body.opens_on||null,closes_on:body.closes_on||null,eligibility:body.eligibility&&typeof body.eligibility==="object"?body.eligibility:{},required_documents:Array.isArray(body.required_documents)?body.required_documents:[],tax_rate:tax,tax_approval_reference:String(body.tax_approval_reference||"").trim()||null,management_approval_reference:String(body.management_approval_reference||"").trim()||null,terms_approval_reference:String(body.terms_approval_reference||"").trim()||null,early_settlement_allowed:body.early_settlement_allowed===true,compounding_allowed:false,status:"draft",created_by:user.id}).select("*").single();
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
    if(!legal&&(!before.terms_approval_reference||!before.management_approval_reference))return out({error:"Management and terms approval references are required before finance approval."},409);
    if(!legal&&Number(before.term_days)!==120&&(!before.tax_approval_reference||!before.management_approval_reference))return out({error:"Non-standard tenure requires management and tax approval references."},409);
    if(!legal&&before.tax_rate!==null&&!before.tax_approval_reference)return out({error:"A tax approval reference is required for configured deductions."},409);
    const now=new Date().toISOString();
    const patch:any={[actorField]:user.id,[refField]:reference,[atField]:now,updated_at:now};
    if(legal){patch.legal_gate_cleared_at=now;patch.legal_gate_cleared_by=user.id;}
    else{patch.terms_approved_at=now;patch.terms_approved_by=user.id;}
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
    if(action==="open_opportunity"&&(!before.legal_gate_cleared_at||!before.terms_approved_at||!before.proposed_return_rate||!before.term_days||!before.terms_approval_reference||!before.management_approval_reference))return out({error:"Legal gate, approved terms, rate and management approval must be recorded before publication."},409);
    if(action==="open_opportunity"&&Number(before.term_days)!==120&&(!before.tax_approval_reference||!before.management_approval_reference))return out({error:"Optional tenure requires management and tax approval."},409);
    if(action==="open_opportunity"&&before.tax_rate!==null&&!before.tax_approval_reference)return out({error:"Tax settings are not approved."},409);
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
    if(!Number.isFinite(principal)||principal<=0||principal<Number(opp.minimum_commitment)|| (opp.maximum_commitment!==null&&principal>Number(opp.maximum_commitment)))return out({error:"Commitment amount is outside the approved minimum/maximum."},400);
    if(rate!==Number(opp.proposed_return_rate)||days!==Number(opp.term_days))return out({error:"Rate and tenure must match the approved opportunity terms."},409);
    if(!opp.legal_gate_cleared_at||!opp.terms_approved_at||!opp.legal_approval_reference||!opp.finance_approval_reference)return out({error:"The legal and commercial approval gates are not cleared."},409);
    const {data:prior}=await admin.from("funding_commitments").select("principal_amount").eq("opportunity_id",opportunity).not("status","in",'("(cancelled,rejected)")');
    const already=(prior||[]).reduce((s,x)=>s+Number(x.principal_amount),0);
    if(already+principal>Number(opp.target_amount))return out({error:"Total commitments cannot exceed the opportunity target amount."},400);
    const agreement=String(body.agreement_reference||"").trim(),signed=String(body.signed_at||"").trim();
    const signedAt=agreement&&signed?new Date(signed):null;
    const isSigned=!!(agreement&&signedAt&&!Number.isNaN(signedAt.getTime()));
    const maturity=isSigned?new Date(signedAt!.getTime()+days*86400000).toISOString().slice(0,10):null;
    const termsSnapshot={opportunity_id:opp.id,reference_code:opp.reference_code,title:opp.title,funding_purpose:opp.funding_purpose,principal_amount:principal,currency_code:opp.currency_code,return_type:opp.return_type,return_rate:rate,day_count_basis:opp.day_count_basis,term_days:days,tax_rate:opp.tax_rate,other_deductions:opp.other_deductions,early_settlement_allowed:opp.early_settlement_allowed,compounding_allowed:false,terms_version:opp.terms_version,legal_approval_reference:opp.legal_approval_reference,finance_approval_reference:opp.finance_approval_reference};
    const {data,error}=await admin.from("funding_commitments").insert({opportunity_id:opportunity,funder_id:funder,principal_amount:principal,currency_code:opp.currency_code,agreed_return_rate:rate,term_days:days,return_type:opp.return_type,day_count_basis:opp.day_count_basis,tax_rate_snapshot:opp.tax_rate,deductions_snapshot:opp.other_deductions,terms_snapshot:termsSnapshot,terms_version:opp.terms_version,early_settlement_allowed:opp.early_settlement_allowed,compounding_allowed:false,status:isSigned?"committed":"agreement_pending",agreement_reference:isSigned?agreement:null,signed_at:isSigned?signedAt!.toISOString():null,terms_locked_at:isSigned?new Date().toISOString():null,accepted_at:isSigned?new Date().toISOString():null,maturity_date:maturity}).select("*").single();
    if(error)throw error;await audit("commitment",data.id,"created",null,data);return out({success:true,record:data});
  }
  if(action==="sign_commitment"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const id=Number(body.id),agreement=String(body.agreement_reference||"").trim(),signed=String(body.signed_at||"").trim();
    if(!Number.isSafeInteger(id)||agreement.length<2||agreement.length>180||!signed)return out({error:"Commitment, signed agreement reference and signed date are required."},400);
    const signedDate=new Date(signed);
    if(Number.isNaN(signedDate.getTime())||signedDate.getTime()>Date.now()+86400000)return out({error:"Valid signed date is required."},400);
    const {data:before}=await admin.from("funding_commitments").select("*").eq("id",id).maybeSingle();
    if(!before||!["pending_agreement","agreement_pending","commitment_submitted"].includes(before.status))return out({error:"Only submitted commitments awaiting a signed agreement can be activated for payment."},409);
    const maturity=new Date(signedDate.getTime()+Number(before.term_days)*86400000).toISOString().slice(0,10);
    const {data,error}=await admin.from("funding_commitments").update({status:"payment_pending",agreement_reference:agreement,signed_at:signedDate.toISOString(),terms_locked_at:new Date().toISOString(),accepted_at:new Date().toISOString(),maturity_date:maturity,updated_at:new Date().toISOString()}).eq("id",id).eq("status","pending_agreement").select("*").maybeSingle();
    if(error)throw error;if(!data)return out({error:"Commitment changed concurrently; refresh and retry."},409);
    await audit("commitment",id,"agreement_signed_terms_locked",before,data);return out({success:true,record:data});
  }
  if(action==="record_receipt"){
    if(!(await need("create")))return out({error:"Funding create permission required."},403);
    const cid=Number(body.commitment_id),amount=Number(body.amount);if(!cid||!Number.isFinite(amount)||amount<=0)return out({error:"Commitment and positive receipt amount required."},400);
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",cid).maybeSingle();
    if(!commit||!["committed","payment_pending","funds_pending","funded","active_funding"].includes(commit.status))return out({error:"A signed commitment is required before recording funds."},409);
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
    if(before.created_by===user.id)return out({error:"The receipt recorder cannot verify their own receipt."},403);
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
    await admin.from("funding_commitments").update({status:"active_funding",updated_at:new Date().toISOString()}).eq("id",receipt.commitment_id);
    await audit("receipt",id,"verified_and_posted",before,receipt);return out({success:true,record:receipt,commitment:commit});
  }
  if(action==="process_maturities"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const today=new Date().toISOString().slice(0,10);
    const {data:due,error}=await admin.from("funding_commitments").select("*").in("status",["funded","active_funding"]).lte("maturity_date",today).limit(200);
    if(error)throw error;
    const processed=[];
    for(const commitment of due||[]){
      const {data:changed,error:updateError}=await admin.from("funding_commitments").update({status:"matured",updated_at:new Date().toISOString()}).eq("id",commitment.id).in("status",["funded","active_funding"]).select("*").maybeSingle();
      if(updateError)throw updateError;
      if(changed) { await audit("commitment",commitment.id,"matured",commitment,changed); processed.push(changed); }
    }
    return out({success:true,processed:processed.length,commitments:processed});
  }
  if(action==="allocate_project"){
    if(!(await need("edit")))return out({error:"Funding edit permission required."},403);
    const cid=Number(body.commitment_id),pid=Number(body.project_id),amount=Number(body.allocated_amount);
    if(!cid||!pid||!Number.isFinite(amount)||amount<=0)return out({error:"Commitment, project and positive allocation required."},400);
    const {data:commit}=await admin.from("funding_commitments").select("*").eq("id",cid).maybeSingle();
    if(!commit||!["funded","active_funding","matured","overdue"].includes(commit.status))return out({error:"Only funded commitments can be allocated."},409);
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
    const {data:allLedger}=await admin.from("funding_liability_ledger").select("entry_type,amount").eq("commitment_id",paid.commitment_id);
    const receivedPrincipal=(allLedger||[]).filter((x:any)=>x.entry_type==="principal_received").reduce((n:number,x:any)=>n+Number(x.amount),0);
    const repaidPrincipal=(allLedger||[]).filter((x:any)=>x.entry_type==="principal_repaid").reduce((n:number,x:any)=>n+Number(x.amount),0);
    const fullySettled=repaidPrincipal>=receivedPrincipal-0.01;
    await admin.from("funding_commitments").update({status:fullySettled?"fully_settled":"partially_settled",updated_at:new Date().toISOString()}).eq("id",paid.commitment_id);
    await audit("settlement",id,"paid_and_posted",before,paid);return out({success:true,record:paid,commitment_status:fullySettled?"fully_settled":"partially_settled"});
  }
  return out({error:"Unsupported funding action."},400);
 }catch(e){console.error("Funding workflow",e);return out({error:"Funding workflow could not be completed."},500);}
});
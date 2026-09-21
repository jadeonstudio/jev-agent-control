import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createDecisionEngine } from '../src/engine.mjs';
import { setMode } from '../src/storage.mjs';
import { createTrainingStore } from '../src/training/store.mjs';
import { digest } from '../src/training/schema.mjs';
import { evaluateStore } from '../src/training/evaluate.mjs';
import { buildDataset, exportDataset, validateDatasetSource } from '../src/training/dataset.mjs';

// Synthetic inference + a real harmless Node assertion. This proves plumbing, NOT model quality.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-pipeline-')));
const store = createTrainingStore({home});
const engine = createDecisionEngine({home, env:{TYPESAFE_API_KEY:'synthetic-demo-not-a-real-key'}, provider:async()=>({
  model:'jev-1.13.0',answers:{next:{type:'choice',choice:'inspect',confidence:.99,probabilities:{inspect:.99,retry:.01}}},usage:{input_tokens:100,output_tokens:0},
})});
try {
  store.setCapture(true);setMode(home,'on',{});
  const request={purpose:'retry',risk:'routine',state:{failure:'A deterministic assertion needs investigation, not a blind retry'},
    questions:{next:{type:'choice',instructions:'Choose the next bounded action.',criteria:{inspect:'Inspect the assertion',retry:'Repeat without changes'}}},
    trace:{task_id:randomUUID(),snapshot_id:digest('synthetic-demo-snapshot')}};
  const decision=await engine.decide(request);
  const evidence=execFileSync(process.execPath,['-e','require("node:assert/strict").equal(2+2,4);console.log("fixture assertion passed")'],{encoding:'utf8'});
  const ref='sha256:'+digest(evidence);
  store.outcome({decision_id:decision.id,execution_id:randomUUID(),executed:true,final:true,source:'runner',executed_answers:{next:'inspect'},
    metrics:{task_succeeded:true,tests_passed:true,retry_count:0,escalated:false},
    checks:[{kind:'tests',passed:true,required:true,scope:'task',evidence_ref:ref}],labels:[]});
  // An explicit fixture annotation, separately recorded; passing the build was NOT the label.
  store.outcome({decision_id:decision.id,execution_id:randomUUID(),executed:false,final:true,source:'human',executed_answers:{},metrics:{},checks:[],
    labels:[{question_id:'next',value:'inspect',source:'human',label_confidence:1,evidence_ref:'sha256:'+digest('synthetic fixture expected target')}]});
  evaluateStore(store);
  const validation=validateDatasetSource(store),first=buildDataset(store),second=buildDataset(store);
  const output=exportDataset(store,first.dataset_version);
  if(!validation.ok||first.sample_count!==1||first.dataset_version!==second.dataset_version)throw new Error('PIPELINE_VALIDATION_FAILED');
  console.log(JSON.stringify({ok:true,synthetic:true,externalApiCalls:0,taskAssertionExecuted:true,samples:output.samples,reproducible:true,
    exportFormat:output.format,trainingExecuted:false,temporaryDataRemoved:true},null,2));
} finally {engine.close();fs.rmSync(home,{recursive:true,force:true});}

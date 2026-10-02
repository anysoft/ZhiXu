const fs=require('fs'),path=require('path'),ts=require(process.cwd()+'/node_modules/typescript');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.name.startsWith('.')?[]:x.isDirectory()?walk(path.join(d,x.name)):[path.join(d,x.name)]);
const sources=walk('src').filter(f=>/\.[jt]sx?$/.test(f)), backend=walk('back').filter(f=>/\.ts$/.test(f));
const files=[],literals=[],uses=[],enums=[],errors=[],formats=[],brands=[],stateAssignments=[];
const uiProps=new Set(['title','label','message','description','placeholder','tooltip','alt','aria-label','okText','cancelText','emptyText','help','extra','loadingText']);
for(const file of sources){
 const raw=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true),start=literals.length,useStart=uses.length;
 const add=(arr,n,obj)=>arr.push({file,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,...obj});
 function visit(n){
  if(ts.isCallExpression(n)&&/^(intl|Intl)\.(get|getHTML)$/.test(n.expression.getText(sf))){const a=n.arguments[0];if(a&&ts.isStringLiteral(a))add(uses,n,{key:a.text});else add(uses,n,{dynamic:a?.getText(sf)});}
  if(ts.isJsxText(n)&&/[A-Za-z\u3400-\u9fff]/.test(n.text)) add(literals,n,{kind:'jsx-text',value:n.text.trim().replace(/\s+/g,' ')});
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)){
   const value=ts.isTemplateExpression(n)?n.getText(sf):n.text,p=n.parent;
   let kind;
   if(ts.isJsxAttribute(p)&&uiProps.has(p.name.getText(sf)))kind='ui-attribute';
   if(ts.isJsxExpression(p)&&ts.isJsxAttribute(p.parent)&&uiProps.has(p.parent.name.getText(sf)))kind='ui-attribute-expression';
   if(ts.isPropertyAssignment(p)&&p.initializer===n&&uiProps.has(p.name.getText(sf).replace(/['"]/g,'')))kind='ui-property-candidate';
   if(ts.isJsxExpression(p)&&!ts.isJsxAttribute(p.parent))kind='jsx-expression-candidate';
   if(ts.isCallExpression(p)&&/^(message|notification)\.(error|success|info|warning|warn)$/.test(p.expression.getText(sf)))kind='toast';
   if(kind&&/[A-Za-z\u3400-\u9fff]/.test(value))add(literals,n,{kind,value});
   if(/QingLong|青龙|qinglong|枝序/.test(value))add(brands,n,{value,context:p.getText(sf).slice(0,300)});
  }
  if(ts.isCallExpression(n)&&/toLocale|\.format$|prettyBytes|diffTime|toFixed|Intl\.(DateTimeFormat|NumberFormat)/.test(n.expression.getText(sf)))add(formats,n,{expression:n.getText(sf)});
  ts.forEachChild(n,visit);
 }
 visit(sf);files.push({file,intl_import:raw.includes('react-intl-universal'),static_translation_calls:uses.slice(useStart).filter(x=>x.key).length,ui_candidates:literals.length-start});
}
for(const file of backend){
 const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 function visit(n){
  const line=sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;
  if(ts.isTypeAliasDeclaration(n)&&ts.isUnionTypeNode(n.type)){
   const values=n.type.types.filter(t=>ts.isLiteralTypeNode(t)&&ts.isStringLiteral(t.literal)).map(t=>t.literal.text);
   if(values.length)enums.push({file,line,name:n.name.text,values});
  }
  if(ts.isPropertySignature(n)&&n.type&&ts.isUnionTypeNode(n.type)){
   const values=n.type.types.filter(t=>ts.isLiteralTypeNode(t)&&ts.isStringLiteral(t.literal)).map(t=>t.literal.text);
   if(values.length)enums.push({file,line,name:n.parent.name?.text+'.'+n.name.getText(sf),values});
  }
  if(ts.isVariableDeclaration(n)&&n.initializer){
   let a=n.initializer;while(ts.isAsExpression(a))a=a.expression;
   if(ts.isArrayLiteralExpression(a)&&/status|state|origin|type|phase|stage|polic|event/i.test(n.name.getText(sf))){
    const values=a.elements.filter(ts.isStringLiteral).map(x=>x.text);
    if(values.length)enums.push({file,line,name:n.name.getText(sf),values});
   }
  }
  if(ts.isEnumDeclaration(n))enums.push({file,line,name:n.name.text,values:n.members.map(m=>m.initializer?.getText(sf)||m.name.getText(sf))});
  if(ts.isPropertyAssignment(n)&&/^(state|status|health|phase|stage|origin|readiness|lifecycle_state|dirty_state)$/.test(n.name.getText(sf).replace(/['"]/g,''))&&ts.isStringLiteral(n.initializer))stateAssignments.push({file,line,field:n.name.getText(sf),value:n.initializer.text});
  if(ts.isStringLiteral(n)&&/^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(n.text)){
   let p=n.parent,contexts=[];for(let i=0;p&&i<3;i++,p=p.parent)contexts.push(p.getText(sf).slice(0,500));
   if(contexts.some(s=>/Error\(|error_code|\bfail\(|\breject\(|\bassert\(/.test(s)))errors.push({file,line,code:n.text,context:contexts[0]});
  }
  ts.forEachChild(n,visit);
 }visit(sf);
}
const resource={};for(const locale of ['zh-CN','en-US']){
 const file='src/locales/'+locale+'.json',raw=fs.readFileSync(file,'utf8'),sf=ts.parseJsonText(file,raw),seen=new Set(),duplicates=[];
 const visit=n=>{if(ts.isPropertyAssignment(n)){const k=n.name.text;if(seen.has(k))duplicates.push(k);seen.add(k);}ts.forEachChild(n,visit)};visit(sf);
 resource[locale]={count:Object.keys(JSON.parse(raw)).length,duplicates,values:JSON.parse(raw)};
}
const zh=resource['zh-CN'].values,en=resource['en-US'].values;
const parity={zh_keys:resource['zh-CN'].count,en_keys:resource['en-US'].count,missing_zh:Object.keys(en).filter(k=>!(k in zh)),missing_en:Object.keys(zh).filter(k=>!(k in en)),duplicate_zh:resource['zh-CN'].duplicates,duplicate_en:resource['en-US'].duplicates,used_missing_zh:uses.filter(u=>u.key&&!(u.key in zh)),used_missing_en:uses.filter(u=>u.key&&!(u.key in en)),same_values:Object.keys(zh).filter(k=>en[k]===zh[k]),empty_values:{zh:Object.keys(zh).filter(k=>!zh[k]),en:Object.keys(en).filter(k=>!en[k])}};
const out={method:'TypeScript AST inventory; candidates require semantic review, not a zero-hardcoding gate. Includes all non-generated src TS/JS, regardless of route reachability. Error candidates are not proven UI reachable.',files,literals,translation_uses:uses,parity,formats,brands,backend_enum_declarations:enums,backend_error_candidates:errors,backend_state_assignments:stateAssignments};
fs.writeFileSync('diagnostics/i18n/i18n-inventory.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({files:files.length,candidates:literals.length,enums:enums.length,error_codes:new Set(errors.map(x=>x.code)).size,parity},null,2));

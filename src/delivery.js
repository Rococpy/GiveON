export function isDirect(store,eventId,slot) {
  return store.get('SELECT delivery_mode FROM prizes WHERE event_id=? AND slot=?',eventId,slot)?.delivery_mode==='DIRECT';
}

export function productNameLabel(product,revealPrivate=false) {
  return revealPrivate&&!product.publicName?`비공개(${product.name})`:product.name;
}

export function productInfo(store,vault,event,slot,revealPrivate=false) {
  const prize=store.get('SELECT name,name_public,delivery_mode,status FROM prizes WHERE event_id=? AND slot=?',event.id,slot);
  if(!prize)return null;
  const named=Boolean(prize.name),metadata=named?vault.open(prize.name,`product-name:${event.id}:${slot}`):null;
  // 기존 암호문에는 이 설정이 없으므로 수령 뒤에도 비공개를 유지합니다.
  const revealAfterDelivery=metadata?.revealAfterDelivery===true;
  const publicName=Boolean(prize.name_public)||(revealAfterDelivery&&prize.status==='DELIVERED');
  const name=!publicName&&!revealPrivate?'비공개 상품':named?metadata.text:event.status==='DRAFT'?'상품명 미입력':event.title;
  return {slot,name,named,publicName,revealAfterDelivery,direct:prize.delivery_mode==='DIRECT'};
}

export function deliverySummary(store,eventId) {
  const slots=store.all('SELECT slot,delivery_mode FROM prizes WHERE event_id=? ORDER BY slot',eventId);
  const directSlots=slots.filter(p=>p.delivery_mode==='DIRECT').map(p=>p.slot),digitalSlots=slots.filter(p=>p.delivery_mode!=='DIRECT').map(p=>p.slot);
  return {directSlots,digitalSlots,total:slots.length,label:[directSlots.length?`실물·직접 전달 ${directSlots.length}개`:'',digitalSlots.length?`디지털 자동 전달 ${digitalSlots.length}개`:''].filter(Boolean).join(' · ')};
}

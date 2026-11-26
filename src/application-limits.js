export const DEFAULT_APPLICATION_LIMITS=Object.freeze({max_drafts:1,max_pending:2,cooldown_minutes:1,daily_limit:5,draft_idle_days:7,prize_mib:50});
export const APPLICATION_LIMIT_RANGES=Object.freeze({max_drafts:[1,100],max_pending:[1,100],cooldown_minutes:[0,1440],daily_limit:[1,10000],draft_idle_days:[1,365],prize_mib:[1,1024]});
export const applicationLimitsText=limits=>`작성 중 / 승인 대기: ${limits.max_drafts}개 / ${limits.max_pending}개\n생성 간격 / 최근 24시간: ${limits.cooldown_minutes?`${limits.cooldown_minutes}분`:'제한 없음'} / ${limits.daily_limit}회\n초안 보관 / 상품 첨부 총량: ${limits.draft_idle_days}일 / ${limits.prize_mib}MiB`;
export const attachmentBytes=content=>content.images.reduce((total,image)=>total+Buffer.byteLength(image.data,'base64'),0);

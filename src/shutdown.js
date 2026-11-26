// DB 오류로 잠금을 반납하지 못해도 워커·소켓은 반드시 닫습니다.
export async function shutdownResources({client,store,token,code=0,timeoutMs=15000}) {
  // 남은 핸들이 종료를 막으면 PM2가 복구할 수 있도록 비정상 종료합니다.
  setTimeout(()=>process.exit(code||1),timeoutMs).unref();
  let disconnect;
  try { disconnect=client?.destroy(); } catch { /* 다음 자원도 정리 */ }
  try { store?.releaseLease(token); } catch { /* DB 장애 시 잠금은 만료됨 */ }
  try { store?.close(); } catch { /* 종료 제한시간으로 최종 보장 */ }
  try { await disconnect; } catch { /* Discord 오류도 종료를 막지 않음 */ }
  if(process.connected)process.disconnect();
  process.exitCode=code;
}

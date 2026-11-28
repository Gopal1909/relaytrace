// Invoke operation synchronously so model initialization retains the button gesture.
export async function whileOffline<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.onLine) throw new Error('Disable networking for this browser tab before the offline test. No offline state is simulated by this app.');
  let wentOnline = false;
  const recordOnline = () => { wentOnline = true; };
  addEventListener('online', recordOnline);
  try {
    const result = await operation();
    if (wentOnline || navigator.onLine) throw new Error('Networking changed during the test; offline inference is not verified.');
    return result;
  } finally {
    removeEventListener('online', recordOnline);
  }
}

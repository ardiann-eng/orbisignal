'use client'
// app/dashboard/page.tsx
// Monitoring dashboard: shows recent signals, scanner status, and confidence breakdown.

import { useEffect, useState, useCallback } from 'react'

interface SignalRow {
  id:          string
  symbol:      string
  direction:   'LONG' | 'SHORT'
  confidence:  number
  entryLow:    number
  entryHigh:   number
  tp1:         number
  tp2:         number
  stopLoss:    number
  rrRatio:     number
  currentPrice:number
  techScore:   number
  fundScore:   number
  sentScore:   number
  reasons:     string[]
  status:      string
  createdAt:   string
}

interface ScannerStatus {
  timestamp:    string
  scannedCoins: number
  signalsSent:  number
}

export default function Dashboard() {
  const [signals, setSignals]       = useState<SignalRow[]>([])
  const [scanStatus, setScanStatus] = useState<ScannerStatus | null>(null)
  const [loading, setLoading]       = useState(true)

  const refresh = useCallback(async () => {
    const [sigRes, scanRes] = await Promise.all([
      fetch('/api/signals?limit=20'),
      fetch('/api/scanner'),
    ])
    const sigData  = await sigRes.json()
    const scanData = await scanRes.json()
    setSignals(sigData.signals ?? [])
    if (scanData.data) setScanStatus(scanData.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30_000) // auto-refresh every 30s
    return () => clearInterval(interval)
  }, [refresh])

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>
            📡 CryptoSense Dashboard
          </h1>
          <p style={{ margin: '4px 0 0', color: '#666', fontSize: '0.875rem' }}>
            Market scanner · Signal history · Live status
          </p>
        </div>
        <button
          onClick={refresh}
          style={{ padding: '8px 16px', background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Scanner Status Bar */}
      {scanStatus && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          {[
            { label: 'Last Scan', value: new Date(scanStatus.timestamp).toLocaleTimeString('id-ID') },
            { label: 'Coins Scanned', value: scanStatus.scannedCoins },
            { label: 'Signals Sent', value: scanStatus.signalsSent },
            { label: 'Total Signals', value: signals.length },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: '#f5f5f5', borderRadius: 10, padding: '12px 20px',
              minWidth: 140, textAlign: 'center',
            }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
              <div style={{ fontSize: '0.75rem', color: '#666', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Signals Table */}
      {loading ? (
        <p style={{ color: '#666' }}>Loading signals...</p>
      ) : signals.length === 0 ? (
        <p style={{ color: '#666' }}>Belum ada signal tercatat.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ background: '#1a1a2e', color: '#fff' }}>
                {['Symbol', 'Dir', 'Confidence', 'Entry', 'TP1', 'SL', 'R:R', 'Tech/Fund/Sent', 'Status', 'Time'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {signals.map((s, i) => (
                <tr key={s.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{s.symbol.replace('USDT', '')}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      background:   s.direction === 'LONG' ? '#e6fbe9' : '#fce6e6',
                      color:        s.direction === 'LONG' ? '#1a7a2e' : '#b91c1c',
                      padding:      '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: '0.8rem',
                    }}>
                      {s.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 60, height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden',
                      }}>
                        <div style={{
                          width:      `${s.confidence}%`, height: '100%',
                          background: s.confidence >= 80 ? '#16a34a' : s.confidence >= 65 ? '#d97706' : '#dc2626',
                          borderRadius: 3,
                        }} />
                      </div>
                      <span style={{ fontWeight: 600 }}>{s.confidence}</span>
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>${s.entryLow} – ${s.entryHigh}</td>
                  <td style={{ padding: '10px 12px', color: '#16a34a' }}>${s.tp1}</td>
                  <td style={{ padding: '10px 12px', color: '#dc2626' }}>${s.stopLoss}</td>
                  <td style={{ padding: '10px 12px' }}>1:{s.rrRatio}</td>
                  <td style={{ padding: '10px 12px', color: '#555', fontSize: '0.8rem' }}>
                    {s.techScore}/{s.fundScore}/{s.sentScore}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      fontSize: '0.75rem', padding: '2px 6px', borderRadius: 4,
                      background: s.status === 'ACTIVE' ? '#dbeafe' : '#f3f4f6',
                      color:      s.status === 'ACTIVE' ? '#1d4ed8' : '#6b7280',
                    }}>
                      {s.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#666', fontSize: '0.8rem' }}>
                    {new Date(s.createdAt).toLocaleString('id-ID', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

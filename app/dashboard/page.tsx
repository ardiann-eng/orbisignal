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

import TradingChart from '@/components/TradingChart'

export default function Dashboard() {
  const [signals, setSignals]       = useState<SignalRow[]>([])
  const [scanStatus, setScanStatus] = useState<ScannerStatus | null>(null)
  const [loading, setLoading]       = useState(true)
  const [selectedSignal, setSelectedSignal] = useState<SignalRow | null>(null)
  const [chartData, setChartData]   = useState<any[]>([])

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

  const loadChart = async (symbol: string) => {
    const res = await fetch(`/api/charts?symbol=${encodeURIComponent(symbol)}&timeframe=1h`)
    const result = await res.json()
    if (result.success) setChartData(result.data)
  }

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60_000)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (selectedSignal) {
      loadChart(selectedSignal.symbol)
    }
  }, [selectedSignal])

  return (
    <main style={{ padding: '2rem', background: '#0b0e11', minHeight: '100vh', color: '#fff', fontFamily: 'Inter, sans-serif' }}>
      
      {/* Chart Section */}
      {selectedSignal && (
        <div style={{ marginBottom: '2rem', padding: '1rem', background: '#131722', borderRadius: 12, border: '1px solid #2a2e39 shadow-xl' }}>
           <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0 }}>📊 {selectedSignal.symbol} Live Analysis</h2>
              <button 
                onClick={() => setSelectedSignal(null)}
                style={{ background: 'transparent', border: 'none', color: '#ff4d4d', cursor: 'pointer' }}>✖ Close Chart</button>
           </div>
           <TradingChart 
            data={chartData} 
            symbol={selectedSignal.symbol}
            entry={(selectedSignal.entryLow + selectedSignal.entryHigh) / 2}
            tp1={selectedSignal.tp1}
            tp2={selectedSignal.tp2}
            sl={selectedSignal.stopLoss}
           />
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#f0b90b' }}>
            ORBIS // Market Terminal
          </h1>
          <p style={{ margin: '4px 0 0', color: '#848e9c', fontSize: '0.9rem' }}>
            Professional Liquidity & Pattern Intelligence
          </p>
        </div>
        <button
          onClick={refresh}
          style={{ padding: '10px 20px', background: '#f0b90b', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
        >
          🔄 Refresh Data
        </button>
      </div>

      {/* Scanner Status */}
      {scanStatus && (
        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '2rem' }}>
          {[
            { label: 'Scanned', value: scanStatus.scannedCoins },
            { label: 'Signals', value: scanStatus.signalsSent },
            { label: 'Uptime', value: 'Live' },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: '#1e2329', padding: '15px 30px', borderRadius: 8, border: '1px solid #2b3139' }}>
              <div style={{ color: '#848e9c', fontSize: '0.75rem', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Signals Table */}
      <div style={{ background: '#131722', borderRadius: 12, border: '1px solid #2a2e39', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: '#1e2329', color: '#848e9c', fontSize: '0.75rem', textTransform: 'uppercase' }}>
              <th style={{ padding: '16px' }}>Asset</th>
              <th>Action</th>
              <th>Confidence</th>
              <th>Price Target</th>
              <th>Risk Reward</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id} style={{ borderBottom: '1px solid #2a2e39', cursor: 'pointer' }} onClick={() => setSelectedSignal(s)}>
                <td style={{ padding: '16px', fontWeight: 600 }}>{s.symbol.replace('/USDT', '')}</td>
                <td>
                  <span style={{ color: s.direction === 'LONG' ? '#2ebd85' : '#f6465d', fontWeight: 700 }}>
                    {s.direction === 'LONG' ? 'BUY' : 'SELL'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 40, height: 4, background: '#2b3139', borderRadius: 2 }}>
                       <div style={{ width: `${s.confidence}%`, height: '100%', background: '#f0b90b' }} />
                    </div>
                    {s.confidence}%
                  </div>
                </td>
                <td>{s.tp1.toFixed(2)}</td>
                <td>1:{s.rrRatio}</td>
                <td>
                  <span style={{ fontSize: '0.75rem', color: s.status === 'ACTIVE' ? '#f0b90b' : '#848e9c' }}>{s.status}</span>
                </td>
                <td>
                  <button style={{ background: '#2b3139', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: 4, fontSize: '0.75rem' }}>View Chart</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}

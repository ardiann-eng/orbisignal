'use client'
// components/TradingChart.tsx
import { useEffect, useRef } from 'react'
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, LineData, HistogramData } from 'lightweight-charts'

interface TradingChartProps {
    data: any[]
    symbol: string
    entry?: number
    tp1?: number
    tp2?: number
    tp3?: number
    sl?: number
}

export default function TradingChart({ data, symbol, entry, tp1, tp2, tp3, sl }: TradingChartProps) {
    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)

    useEffect(() => {
        if (!chartContainerRef.current || !data?.length) return

        const handleResize = () => {
            if (chartRef.current) {
                chartRef.current.applyOptions({ width: chartContainerRef.current?.clientWidth });
            }
        }

        // Initialize Chart
        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: '#131722' },
                textColor: '#d1d4dc',
            },
            grid: {
                vertLines: { color: 'rgba(42, 46, 57, 0.2)' },
                horzLines: { color: 'rgba(42, 46, 57, 0.2)' },
            },
            localization: {
                priceFormatter: (price: number) => {
                    if (price > 1) return price.toFixed(2);
                    if (price > 0.01) return price.toFixed(4);
                    return price.toFixed(6);
                },
            },
            width: chartContainerRef.current.clientWidth,
            height: 600,
            timeScale: {
                borderColor: '#485c7b',
                timeVisible: true,
                secondsVisible: false,
            },
        })

        chartRef.current = chart

        // 1. Candlestick Series
        const candleSeries = (chart as any).addCandlestickSeries({
            upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
            wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        });
        candleSeries.setData(data as CandlestickData[]);

        // 2. EMA Overlays
        const ema9Series = (chart as any).addLineSeries({ color: '#2962FF', lineWidth: 1, title: 'EMA 9' });
        const ema21Series = (chart as any).addLineSeries({ color: '#FF9800', lineWidth: 1, title: 'EMA 21' });
        const ema50Series = (chart as any).addLineSeries({ color: '#E91E63', lineWidth: 1, title: 'EMA 50' });

        ema9Series.setData(data.map(d => ({ time: d.time, value: d.ema9 })).filter(d => d.value) as LineData[]);
        ema21Series.setData(data.map(d => ({ time: d.time, value: d.ema21 })).filter(d => d.value) as LineData[]);
        ema50Series.setData(data.map(d => ({ time: d.time, value: d.ema50 })).filter(d => d.value) as LineData[]);

        // 3. Price Lines (Entry, TP, SL)
        if (entry) {
            candleSeries.createPriceLine({
                price: entry, color: '#FFD700', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY',
            });
        }
        if (tp1) {
            candleSeries.createPriceLine({
                price: tp1, color: '#26a69a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP1',
            });
        }
        if (sl) {
            candleSeries.createPriceLine({
                price: sl, color: '#ef5350', lineWidth: 2, lineStyle: 1, axisLabelVisible: true, title: 'SL',
            });
        }

        // 4. Volume Series (Pane 2)
        const volumeSeries = (chart as any).addHistogramSeries({
            color: '#26a69a',
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume', 
        });
        
        (chart as any).priceScale('volume').applyOptions({
            scaleMargins: { top: 0.85, bottom: 0 }, // Bottom 15%
        });

        volumeSeries.setData(data.map(d => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)'
        })) as HistogramData[]);

        // 5. MACD Series (Pane 3)
        const macdLineSeries = (chart as any).addLineSeries({ color: '#2962FF', lineWidth: 1, priceScaleId: 'macd', title: 'MACD' });
        const macdSignalSeries = (chart as any).addLineSeries({ color: '#FF9800', lineWidth: 1, priceScaleId: 'macd', title: 'Signal' });
        const macdHistSeries = (chart as any).addHistogramSeries({ priceScaleId: 'macd' });

        (chart as any).priceScale('macd').applyOptions({
            scaleMargins: { top: 0.7, bottom: 0.15 }, // Next 15%
        });

        macdLineSeries.setData(data.map(d => ({ time: d.time, value: d.macd })).filter((d: any) => d.value !== null) as LineData[]);
        macdSignalSeries.setData(data.map(d => ({ time: d.time, value: d.macdSignal })).filter((d: any) => d.value !== null) as LineData[]);
        macdHistSeries.setData(data.map(d => ({ 
            time: d.time, 
            value: d.macdHist,
            color: (d.macdHist || 0) >= 0 ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)'
        })).filter((d: any) => d.value !== null) as HistogramData[]);

        // 6. RSI Series (Pane 4)
        const rsiSeries = (chart as any).addLineSeries({ color: '#7E57C2', lineWidth: 1, priceScaleId: 'rsi', title: 'RSI' });
        
        (chart as any).priceScale('rsi').applyOptions({
            scaleMargins: { top: 0.55, bottom: 0.3 }, // Next 15%
        });

        rsiSeries.setData(data.map(d => ({ time: d.time, value: d.rsi })).filter(d => d.value !== null) as LineData[]);

        // RSI Levels (70, 50, 30) - using price lines on the RSI scale
        [70, 50, 30].forEach(level => {
            rsiSeries.createPriceLine({
                price: level,
                color: 'rgba(42, 46, 57, 0.5)',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
            });
        });

        console.log('MACD loaded');
        console.log('RSI loaded');

        // Fit Content
        chart.timeScale().fitContent()

        window.addEventListener('resize', handleResize)

        console.log('EMA loaded')
        console.log('volume loaded')

        return () => {
            window.removeEventListener('resize', handleResize)
            chart.remove()
        }
    }, [data, symbol, entry, tp1, tp2, tp3, sl])

    return (
        <div style={{ position: 'relative', width: '100%', border: '1px solid #2a2e39', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, color: '#d1d4dc', fontSize: '0.875rem', fontWeight: 'bold' }}>
                {symbol} · 1H · Candlestick
            </div>
            <div ref={chartContainerRef} style={{ width: '100%' }} />
        </div>
    )
}

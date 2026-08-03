import React, { useState } from 'react';
import { 
  X, 
  History, 
  Wifi, 
  Eye, 
  Copy, 
  Check, 
  TrendingUp, 
  Receipt, 
  Calendar,
  Search
} from 'lucide-react';
import { TransactionReceipt } from '../types';
import { formatCurrency } from '../data';

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  transactions: TransactionReceipt[];
  onSelectReceipt: (receipt: TransactionReceipt) => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({
  isOpen,
  onClose,
  transactions,
  onSelectReceipt,
}) => {
  const [filterQuery, setFilterQuery] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  if (!isOpen) return null;

  const totalRevenue = transactions.reduce((acc, tx) => acc + tx.total, 0);
  const totalVouchersIssued = transactions.reduce((acc, tx) => acc + tx.vouchers.length, 0);
  const avgTicket = transactions.length > 0 ? totalRevenue / transactions.length : 0;

  const filteredTransactions = transactions.filter((tx) => {
    if (!filterQuery) return true;
    const q = filterQuery.toLowerCase();
    const matchesId = tx.id.toLowerCase().includes(q);
    const matchesCustomer = tx.customerReference?.toLowerCase().includes(q);
    const matchesVoucher = tx.vouchers.some((v) => v.code.toLowerCase().includes(q));
    return matchesId || matchesCustomer || matchesVoucher;
  });

  const handleCopy = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-gray-200 max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gray-900 text-white flex items-center justify-center shadow-xs">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Session Sales Log</h2>
              <p className="text-xs text-gray-500">
                Completed transactions & Wi-Fi voucher archive
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-xl hover:bg-gray-200 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats Strip */}
        <div className="px-6 py-3 bg-white border-b border-gray-200 grid grid-cols-3 gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] text-gray-500 font-medium block">Total Revenue</span>
              <span className="text-base font-bold font-mono text-gray-900">
                {formatCurrency(totalRevenue)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] text-gray-500 font-medium block">Vouchers Issued</span>
              <span className="text-base font-bold font-mono text-gray-900">
                {totalVouchersIssued}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[11px] text-gray-500 font-medium block">Avg Ticket</span>
              <span className="text-base font-bold font-mono text-gray-900">
                {formatCurrency(avgTicket)}
              </span>
            </div>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="px-6 py-3 bg-gray-50/50 border-b border-gray-200 flex items-center justify-between">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter by receipt ID, customer, voucher code..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-gray-200 rounded-xl focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
            />
          </div>
          <span className="text-xs text-gray-500">
            {filteredTransactions.length} transaction{filteredTransactions.length !== 1 ? 's' : ''} recorded
          </span>
        </div>

        {/* Transactions Table/List */}
        <div className="flex-1 overflow-y-auto p-6">
          {filteredTransactions.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center text-gray-400 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
              <Receipt className="w-10 h-10 mb-2 text-gray-300" />
              <p className="text-sm font-medium text-gray-600">No transactions recorded yet</p>
              <p className="text-xs text-gray-400 mt-1">
                Completed sales will appear here with printable Wi-Fi voucher codes.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTransactions.map((tx) => (
                <div
                  key={tx.id}
                  onClick={() => {
                    onSelectReceipt(tx);
                    onClose();
                  }}
                  className="p-4 rounded-2xl bg-white border border-gray-200 hover:border-emerald-500 hover:shadow-md transition-all cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold font-mono text-gray-900 bg-gray-100 px-2 py-0.5 rounded">
                        #{tx.id}
                      </span>
                      <span className="text-xs text-gray-500">{tx.timestamp}</span>
                      <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {tx.paymentMethod}
                      </span>
                    </div>
                    <div className="text-xs text-gray-600 flex items-center gap-2">
                      <span>
                        {tx.items.reduce((sum, item) => sum + item.quantity, 0)} items
                      </span>
                      {tx.customerReference && (
                        <>
                          <span>•</span>
                          <span className="font-semibold text-emerald-700">
                            Customer: {tx.customerReference}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Vouchers Preview Badge */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tx.vouchers.map((voucher, idx) => (
                      <div
                        key={idx}
                        onClick={(e) => handleCopy(voucher.code, e)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-gray-900 text-white text-xs font-mono border border-gray-800 hover:bg-emerald-600 transition-colors cursor-pointer"
                        title="Click to copy voucher code"
                      >
                        <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{voucher.code}</span>
                        {copiedCode === voucher.code ? (
                          <Check className="w-3.5 h-3.5 text-emerald-300" />
                        ) : (
                          <Copy className="w-3 h-3 text-gray-400" />
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Total & Inspect Button */}
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-base font-bold font-mono text-gray-900">
                      {formatCurrency(tx.total)}
                    </span>
                    <div className="px-3 py-1.5 rounded-xl bg-gray-100 text-gray-700 text-xs font-semibold flex items-center gap-1">
                      <Eye className="w-3.5 h-3.5" />
                      <span>View</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 transition-colors cursor-pointer"
          >
            Close Log
          </button>
        </div>
      </div>
    </div>
  );
};

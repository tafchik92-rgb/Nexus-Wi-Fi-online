export type POSItemCategory = 'all' | 'wifi' | 'cafe' | 'hardware' | 'snacks';

export interface POSItem {
  id: string;
  name: string;
  price: number;
  category: Exclude<POSItemCategory, 'all'>;
  description: string;
  durationMinutes?: number;
  bandwidthMbps?: number;
  iconName: string;
  isPopular?: boolean;
}

export interface OrderItem {
  item: POSItem;
  quantity: number;
  notes?: string;
}

export interface WiFiVoucher {
  code: string;
  ssid: string;
  durationLabel: string;
  durationMinutes: number;
  bandwidthMbps: number;
  expiresAt: string;
  generatedAt: string;
  price: number;
}

export interface TransactionReceipt {
  id: string;
  timestamp: string;
  items: OrderItem[];
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  paymentMethod: 'cash' | 'card' | 'qr';
  vouchers: WiFiVoucher[];
  customerReference?: string;
}

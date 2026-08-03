import { POSItem, WiFiVoucher } from './types';

export const INITIAL_POS_ITEMS: POSItem[] = [
  // Wi-Fi Vouchers
  {
    id: 'wifi-1h',
    name: '1-Hour High-Speed Pass',
    price: 2.50,
    category: 'wifi',
    description: '100 Mbps symmetric Wi-Fi access for 60 minutes',
    durationMinutes: 60,
    bandwidthMbps: 100,
    iconName: 'Wifi',
    isPopular: true,
  },
  {
    id: 'wifi-day',
    name: '24-Hour Day Pass',
    price: 7.00,
    category: 'wifi',
    description: 'Unlimited 100 Mbps guest Wi-Fi access for 24 hours',
    durationMinutes: 1440,
    bandwidthMbps: 100,
    iconName: 'Wifi',
    isPopular: true,
  },
  {
    id: 'wifi-week',
    name: '7-Day Unlimited Pass',
    price: 25.00,
    category: 'wifi',
    description: '150 Mbps priority Wi-Fi access for 7 continuous days',
    durationMinutes: 10080,
    bandwidthMbps: 150,
    iconName: 'Wifi',
  },
  {
    id: 'wifi-month',
    name: '30-Day Pro Resident Pass',
    price: 60.00,
    category: 'wifi',
    description: '300 Mbps ultra-fast dedicated access for 30 days',
    durationMinutes: 43200,
    bandwidthMbps: 300,
    iconName: 'Zap',
  },

  // Cafe & Drinks
  {
    id: 'cafe-espresso',
    name: 'Single Origin Espresso',
    price: 3.50,
    category: 'cafe',
    description: 'Double shot Ethiopian heirloom beans',
    iconName: 'Coffee',
  },
  {
    id: 'cafe-coldbrew',
    name: 'Nitro Cold Brew',
    price: 4.75,
    category: 'cafe',
    description: '18-hour steep infused with nitrogen',
    iconName: 'Coffee',
    isPopular: true,
  },
  {
    id: 'cafe-matcha',
    name: 'Iced Matcha Latte',
    price: 5.25,
    category: 'cafe',
    description: 'Ceremonial grade Uji matcha with oat milk',
    iconName: 'CupSoda',
  },
  {
    id: 'cafe-water',
    name: 'Sparkling Alpine Water',
    price: 2.50,
    category: 'cafe',
    description: '500ml chilled glass bottle',
    iconName: 'GlassWater',
  },

  // Snacks & Bakery
  {
    id: 'snack-croissant',
    name: 'Butter Almond Croissant',
    price: 3.80,
    category: 'snacks',
    description: 'Freshly baked buttery pastry with almond flakes',
    iconName: 'Croissant',
    isPopular: true,
  },
  {
    id: 'snack-avocado',
    name: 'Avocado Sourdough Toast',
    price: 8.50,
    category: 'snacks',
    description: 'Artisanal sourdough, microgreens & extra virgin olive oil',
    iconName: 'Utensils',
  },
  {
    id: 'snack-cookie',
    name: 'Dark Chocolate Sea Salt Cookie',
    price: 3.25,
    category: 'snacks',
    description: 'Warm chocolate chip bakery cookie',
    iconName: 'Cookie',
  },

  // Hardware & Extras
  {
    id: 'hw-usb',
    name: 'USB-C 65W Charger Rental',
    price: 3.00,
    category: 'hardware',
    description: 'Full day laptop charging brick rental',
    iconName: 'BatteryCharging',
  },
  {
    id: 'hw-eth',
    name: 'Cat6 Ethernet Cable (2m)',
    price: 5.00,
    category: 'hardware',
    description: 'High-speed wired LAN patch cable',
    iconName: 'Cable',
  },
  {
    id: 'hw-room',
    name: 'Meeting Booth Pass (1 hr)',
    price: 15.00,
    category: 'hardware',
    description: 'Soundproof privacy pod with HDMI display',
    iconName: 'Monitor',
  },
];

export function generateWiFiVoucher(item: POSItem): WiFiVoucher {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    part2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const code = `NEXUS-${part1}-${part2}`;
  const now = new Date();
  const durationMinutes = item.durationMinutes || 60;
  const expires = new Date(now.getTime() + durationMinutes * 60 * 1000);

  return {
    code,
    ssid: 'Nexus_Guest_5G',
    durationLabel: item.name,
    durationMinutes,
    bandwidthMbps: item.bandwidthMbps || 100,
    expiresAt: expires.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    generatedAt: now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    price: item.price,
  };
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

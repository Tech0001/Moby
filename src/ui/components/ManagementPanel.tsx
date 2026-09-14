import { apiFetch } from '@/ui/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/ui/card";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import { Badge } from "@/ui/components/ui/badge";
import { Alert, AlertDescription } from "@/ui/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/ui/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/ui/select";
import { Wallet, Plus, Eye, EyeOff, Copy, Trash2, Key, RefreshCw, Search, ArrowUpDown } from 'lucide-react';

interface WalletInfo {
  id: string;
  name: string;
  chain: string;
  address: string;
  createdAt: number;
}

const supportedChains = [
  { id: 'ethereum', name: 'Ethereum', supported: true },
  { id: 'bitcoin', name: 'Bitcoin', supported: true },
  { id: 'solana', name: 'Solana', supported: true },
  { id: 'xrp', name: 'XRP', supported: true },
  { id: 'xlm', name: 'Stellar', supported: true },
  { id: 'algorand', name: 'Algorand', supported: true },
  { id: 'cardano', name: 'Cardano', supported: true },
  { id: 'lunc', name: 'LUNC', supported: true },
];

const chainColors: Record<string, string> = {
  ethereum: 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20',
  bitcoin: 'bg-orange-500/10 text-orange-500 hover:bg-orange-500/20',
  solana: 'bg-purple-500/10 text-purple-500 hover:bg-purple-500/20',
  xrp: 'bg-gray-500/10 text-gray-500 hover:bg-gray-500/20',
  xlm: 'bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500/20',
  lunc: 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20',
  algorand: 'bg-teal-500/10 text-teal-500 hover:bg-teal-500/20',
  cardano: 'bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20',
};

export function ManagementPanel() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Filtering and Sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [filterChain, setFilterChain] = useState('all');
  const [sortBy, setSortBy] = useState('created_desc');

  // Password state
  const [hasPassword, setHasPassword] = useState(false);
  const [showSetPasswordDialog, setShowSetPasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);

  // Create wallet state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [walletName, setWalletName] = useState('');
  const [walletChain, setWalletChain] = useState('ethereum');
  const [walletPassword, setWalletPassword] = useState('');
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [creating, setCreating] = useState(false);

  // View private key state
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [unlockWalletId, setUnlockWalletId] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'privateKey' | 'mnemonic'>('privateKey');
  const [unlocking, setUnlocking] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  // Delete state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteWalletId, setDeleteWalletId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    checkPasswordAndFetch();
  }, []);

  async function checkPasswordAndFetch() {
    try {
      const res = await apiFetch('/api/wallets/password/exists');
      if (res.ok) {
        const data = await res.json();
        setHasPassword(data.exists);
        if (data.exists) {
          await fetchWallets();
        }
      }
    } catch (err) {
      setError('Failed to check wallet password status');
    } finally {
      setLoading(false);
    }
  }

  async function fetchWallets() {
    try {
      const res = await apiFetch('/api/wallets');
      if (res.ok) {
        const data = await res.json();
        setWallets(data.wallets);
      }
    } catch (err) {
      setError('Failed to load wallets');
    }
  }

  async function handleSetPassword() {
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSettingPassword(true);
    setError('');

    try {
      const res = await apiFetch('/api/wallets/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });

      if (res.ok) {
        setHasPassword(true);
        setShowSetPasswordDialog(false);
        setNewPassword('');
        setConfirmPassword('');
        setSuccess('Wallet password set successfully');
        setTimeout(() => setSuccess(''), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to set password');
      }
    } catch (err) {
      setError('Failed to set password');
    } finally {
      setSettingPassword(false);
    }
  }

  async function handleCreateWallet() {
    if (!walletName.trim()) {
      setError('Wallet name is required');
      return;
    }
    if (!walletPassword) {
      setError('Password is required');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const res = await apiFetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: walletName.trim(),
          password: walletPassword,
          chain: walletChain,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setWallets((prev) => [data.wallet, ...prev]);
        setShowCreateDialog(false);
        setWalletName('');
        setWalletChain('ethereum');
        setWalletPassword('');
        setSuccess('Wallet created successfully');
        setTimeout(() => setSuccess(''), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create wallet');
      }
    } catch (err) {
      setError('Failed to create wallet');
    } finally {
      setCreating(false);
    }
  }

  async function handleUnlock() {
    if (!unlockWalletId || !unlockPassword) return;

    setUnlocking(true);
    setError('');

    try {
      const res = await apiFetch(`/api/wallets/${unlockWalletId}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: unlockPassword }),
      });

      if (res.ok) {
        const data = await res.json();
        setPrivateKey(data.privateKey);
        setMnemonic(data.mnemonic || null);
        setUnlockPassword('');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to unlock wallet');
      }
    } catch (err) {
      setError('Failed to unlock wallet');
    } finally {
      setUnlocking(false);
    }
  }

  async function handleDelete() {
    if (!deleteWalletId) return;

    setDeleting(true);
    setError('');

    try {
      const res = await apiFetch(`/api/wallets/${deleteWalletId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setWallets((prev) => prev.filter((w) => w.id !== deleteWalletId));
        setShowDeleteDialog(false);
        setDeleteWalletId(null);
        setSuccess('Wallet deleted');
        setTimeout(() => setSuccess(''), 3000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete wallet');
      }
    } catch (err) {
      setError('Failed to delete wallet');
    } finally {
      setDeleting(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard');
    setTimeout(() => setSuccess(''), 2000);
  }

  function openUnlockDialog(walletId: string) {
    setUnlockWalletId(walletId);
    setUnlockPassword('');
    setPrivateKey(null);
    setShowPrivateKey(false);
    setShowUnlockDialog(true);
  }

  function closeUnlockDialog() {
    setShowUnlockDialog(false);
    setUnlockWalletId(null);
    setUnlockPassword('');
    setPrivateKey(null);
    setMnemonic(null);
    setViewMode('privateKey');
    setShowPrivateKey(false);
  }

  function openDeleteDialog(walletId: string) {
    setDeleteWalletId(walletId);
    setShowDeleteDialog(true);
  }

  const filteredWallets = wallets
    .filter((wallet) => {
      const matchesSearch =
        wallet.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        wallet.address.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesChain = filterChain === 'all' || wallet.chain === filterChain;
      return matchesSearch && matchesChain;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'name_asc':
          return a.name.localeCompare(b.name);
        case 'name_desc':
          return b.name.localeCompare(a.name);
        case 'chain_asc':
          return a.chain.localeCompare(b.chain);
        case 'created_asc':
          return a.createdAt - b.createdAt;
        case 'created_desc':
          return b.createdAt - a.createdAt;
        default:
          return 0;
      }
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <RefreshCw className="animate-spin h-6 w-6 text-muted-foreground" />
      </div>
    );
  }

  // Show password setup if not set
  if (!hasPassword) {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Key size={20} />
              Wallet Management Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="text-center space-y-4">
              <div className="bg-muted rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
                <Key className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold">Secure Your Wallets</h3>
              <p className="text-muted-foreground max-w-sm mx-auto">
                To securely store wallet private keys, you need to set a wallet password first.
                This password will be used to encrypt all private keys.
              </p>
              <Alert variant="destructive" className="max-w-sm mx-auto text-left">
                <AlertDescription>
                   Warning: If you forget this password, you will lose access to all stored private keys.
                </AlertDescription>
              </Alert>
              <div className="pt-4">
                <Button onClick={() => setShowSetPasswordDialog(true)}>
                  Set Wallet Password
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Set Password Dialog */}
        <Dialog open={showSetPasswordDialog} onOpenChange={setShowSetPasswordDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set Wallet Password</DialogTitle>
              <DialogDescription>
                This password encrypts your private keys. Store it safely - it cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-2">
                <Label>Password (min 8 characters)</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter password"
                />
              </div>
              <div className="space-y-2">
                <Label>Confirm Password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowSetPasswordDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleSetPassword} disabled={settingPassword}>
                {settingPassword ? 'Setting...' : 'Set Password'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert className="border-green-500 text-green-500 bg-green-500/10">
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2">
              <Wallet size={20} />
              Wallets
            </CardTitle>
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Generate Wallet
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Toolbar */}
          <div className="p-4 border-b bg-muted/30 flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search wallets..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <Select value={filterChain} onValueChange={setFilterChain}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="Filter by Chain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Chains</SelectItem>
                  {supportedChains.map((chain) => (
                    <SelectItem key={chain.id} value={chain.id}>
                      {chain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_desc">Newest First</SelectItem>
                  <SelectItem value="created_asc">Oldest First</SelectItem>
                  <SelectItem value="name_asc">Name (A-Z)</SelectItem>
                  <SelectItem value="name_desc">Name (Z-A)</SelectItem>
                  <SelectItem value="chain_asc">Chain (A-Z)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Table */}
          {wallets.length === 0 ? (
            <div className="text-center py-12">
              <div className="bg-muted rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3">
                <Wallet className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground mb-4">
                No wallets found. Generate a new one to get started.
              </p>
              <Button variant="outline" onClick={() => setShowCreateDialog(true)}>
                Generate Wallet
              </Button>
            </div>
          ) : filteredWallets.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No wallets match your filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredWallets.map((wallet) => (
                    <TableRow key={wallet.id}>
                      <TableCell className="font-medium">{wallet.name}</TableCell>
                      <TableCell>
                        <Badge className={`${chainColors[wallet.chain]} hover:bg-opacity-80 transition-colors`}>
                          {wallet.chain}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 max-w-[200px] sm:max-w-xs">
                          <code className="text-xs text-muted-foreground font-mono truncate">
                            {wallet.address}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={() => copyToClipboard(wallet.address)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(wallet.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="View Private Key"
                            onClick={() => openUnlockDialog(wallet.id)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            title="Delete Wallet"
                            onClick={() => openDeleteDialog(wallet.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Wallet Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate New Wallet</DialogTitle>
            <DialogDescription>
              Choose a blockchain network and set up your new wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            
            <div className="space-y-3">
              <Label>Select Network</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {supportedChains.map((chain) => (
                  <div
                    key={chain.id}
                    onClick={() => chain.supported && setWalletChain(chain.id)}
                    className={`
                      cursor-pointer rounded-lg border-2 p-2 text-center transition-all hover:bg-muted/50
                      ${walletChain === chain.id 
                        ? `border-primary bg-${chainColors[chain.id]?.split(' ')[0].replace('bg-', '') || 'primary/10'} ring-1 ring-primary/20` 
                        : 'border-muted bg-card hover:border-primary/20'}
                      ${!chain.supported ? 'opacity-50 cursor-not-allowed grayscale' : ''}
                    `}
                  >
                    <div className="font-medium">{chain.name}</div>
                    {!chain.supported && <div className="text-[9px] text-muted-foreground mt-1">Coming Soon</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Wallet Name</Label>
                <Input
                  value={walletName}
                  onChange={(e) => setWalletName(e.target.value)}
                  placeholder="e.g., Stinky Pete's Wallet"
                />
              </div>
              <div className="space-y-2">
                <Label>Master Password</Label>
                <div className="relative">
                  <Input
                    type={showCreatePassword ? 'text' : 'password'}
                    value={walletPassword}
                    onChange={(e) => setWalletPassword(e.target.value)}
                    placeholder="Enter master password to encrypt"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={() => setShowCreatePassword(!showCreatePassword)}
                  >
                    {showCreatePassword ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateWallet} 
              disabled={creating || !walletName.trim() || !walletPassword}
            >
              {creating ? 'Creating...' : 'Generate Wallet'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlock/View Private Key Dialog */}
      <Dialog open={showUnlockDialog} onOpenChange={(open) => !open && closeUnlockDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>View Wallet Secrets</DialogTitle>
            <DialogDescription>
              Enter your wallet password to decrypt and view your credentials.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!privateKey ? (
              <div className="space-y-2">
                <Label>Wallet Password</Label>
                <Input
                  type="password"
                  value={unlockPassword}
                  onChange={(e) => setUnlockPassword(e.target.value)}
                  placeholder="Enter your wallet password"
                  onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                />
              </div>
            ) : (
              <div className="space-y-4">
                {/* Toggle buttons when mnemonic is available */}
                {mnemonic && (
                  <div className="flex gap-2 border-b pb-3">
                    <Button
                      variant={viewMode === 'privateKey' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setViewMode('privateKey')}
                    >
                      <Key className="h-3 w-3 mr-1" />
                      Private Key
                    </Button>
                    <Button
                      variant={viewMode === 'mnemonic' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setViewMode('mnemonic')}
                    >
                      Seed Phrase
                    </Button>
                  </div>
                )}

                {/* Private Key View */}
                {viewMode === 'privateKey' && (
                  <div className="space-y-2">
                    <Label>Private Key</Label>
                    <div className="relative">
                      <Input
                        type={showPrivateKey ? 'text' : 'password'}
                        value={privateKey}
                        readOnly
                        className="font-mono text-xs pr-20"
                      />
                      <div className="absolute right-1 top-1 flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setShowPrivateKey(!showPrivateKey)}
                        >
                          {showPrivateKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyToClipboard(privateKey)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-destructive">
                      Never share your private key. Anyone with this key can access your funds.
                    </p>
                  </div>
                )}

                {/* Mnemonic/Seed Phrase View */}
                {viewMode === 'mnemonic' && mnemonic && (
                  <div className="space-y-2">
                    <Label>Seed Phrase (Mnemonic)</Label>
                    <div className="relative">
                      <textarea
                        readOnly
                        value={showPrivateKey ? mnemonic : '•'.repeat(mnemonic.length)}
                        className="w-full min-h-[80px] p-3 pr-16 rounded-md border border-input bg-background font-mono text-xs resize-none"
                      />
                      <div className="absolute right-1 top-1 flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setShowPrivateKey(!showPrivateKey)}
                        >
                          {showPrivateKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyToClipboard(mnemonic)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-destructive">
                      Never share your seed phrase. Write it down and store it securely offline.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeUnlockDialog}>
              {privateKey ? 'Close' : 'Cancel'}
            </Button>
            {!privateKey && (
              <Button onClick={handleUnlock} disabled={unlocking}>
                {unlocking ? 'Unlocking...' : 'Unlock'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Wallet</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this wallet? This action cannot be undone.
              Make sure you have backed up the private key if needed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete Wallet'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

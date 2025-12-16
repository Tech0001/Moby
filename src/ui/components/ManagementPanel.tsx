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
import { Wallet, Plus, Eye, EyeOff, Copy, Trash2, Key, RefreshCw } from 'lucide-react';

interface WalletInfo {
  id: string;
  name: string;
  chain: string;
  address: string;
  createdAt: number;
}

export function ManagementPanel() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
  const [creating, setCreating] = useState(false);

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

  // View private key state
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [unlockWalletId, setUnlockWalletId] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [privateKey, setPrivateKey] = useState<string | null>(null);
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
      const res = await fetch('/api/wallets/password/exists');
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
      const res = await fetch('/api/wallets');
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
      const res = await fetch('/api/wallets/password', {
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
      const res = await fetch('/api/wallets', {
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
      const res = await fetch(`/api/wallets/${unlockWalletId}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: unlockPassword }),
      });

      if (res.ok) {
        const data = await res.json();
        setPrivateKey(data.privateKey);
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
      const res = await fetch(`/api/wallets/${deleteWalletId}`, {
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
    setShowPrivateKey(false);
  }

  function openDeleteDialog(walletId: string) {
    setDeleteWalletId(walletId);
    setShowDeleteDialog(true);
  }

  const chainColors: Record<string, string> = {
    ethereum: 'bg-blue-500/10 text-blue-500',
    bitcoin: 'bg-orange-500/10 text-orange-500',
    solana: 'bg-purple-500/10 text-purple-500',
    xrp: 'bg-gray-500/10 text-gray-500',
    xlm: 'bg-cyan-500/10 text-cyan-500',
    lunc: 'bg-yellow-500/10 text-yellow-500',
    algorand: 'bg-teal-500/10 text-teal-500',
    cardano: 'bg-indigo-500/10 text-indigo-500',
  };

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
      <div className="space-y-6">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Key size={20} />
              Wallet Management Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="text-center space-y-4">
              <p className="text-muted-foreground">
                To securely store wallet private keys, you need to set a wallet password first.
                This password will be used to encrypt all private keys.
              </p>
              <p className="text-sm text-destructive">
                Warning: If you forget this password, you will lose access to all stored private keys.
              </p>
              <Button onClick={() => setShowSetPasswordDialog(true)}>
                <Key className="mr-2 h-4 w-4" />
                Set Wallet Password
              </Button>
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
        <Alert className="border-green-500 text-green-500">
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Wallet size={20} />
            Wallets
          </CardTitle>
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Generate Wallet
          </Button>
        </CardHeader>
        <CardContent className="p-4">
          {wallets.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No wallets yet. Click "Generate Wallet" to create one.
            </p>
          ) : (
            <div className="space-y-3">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{wallet.name}</span>
                      <Badge className={chainColors[wallet.chain] || 'bg-gray-500/10'}>
                        {wallet.chain}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
                        {wallet.address}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToClipboard(wallet.address)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openUnlockDialog(wallet.id)}
                    >
                      <Eye className="mr-1 h-3 w-3" />
                      View Key
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => openDeleteDialog(wallet.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Wallet Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate New Wallet</DialogTitle>
            <DialogDescription>
              Create a new wallet. The private key will be encrypted with your wallet password.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label>Blockchain</Label>
              <div className="flex flex-wrap gap-2">
                {supportedChains.map((chain) => (
                  <Button
                    key={chain.id}
                    type="button"
                    variant={walletChain === chain.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setWalletChain(chain.id)}
                    disabled={!chain.supported}
                    className={!chain.supported ? 'opacity-50' : ''}
                  >
                    {chain.name}
                    {!chain.supported && <span className="ml-1 text-xs">(soon)</span>}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Wallet Name</Label>
              <Input
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g., Main Wallet, Cold Storage"
              />
            </div>
            <div className="space-y-2">
              <Label>Wallet Password</Label>
              <Input
                type="password"
                value={walletPassword}
                onChange={(e) => setWalletPassword(e.target.value)}
                placeholder="Enter your wallet password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateWallet} disabled={creating}>
              {creating ? 'Creating...' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlock/View Private Key Dialog */}
      <Dialog open={showUnlockDialog} onOpenChange={(open) => !open && closeUnlockDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>View Private Key</DialogTitle>
            <DialogDescription>
              Enter your wallet password to decrypt and view the private key.
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

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/ui/select"
import { useTheme } from "@/ui/components/ThemeProvider"
import { externalPalettes } from "@/ui/themes/registry"

export function ThemeSelector() {
  const { style, setStyle } = useTheme()

  return (
    <Select value={style} onValueChange={(val: any) => setStyle(val)}>
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder="Select Theme" />
      </SelectTrigger>
      <SelectContent>
        {externalPalettes.map((theme) => (
          <SelectItem key={theme.id} value={theme.id}>
            <div className="flex items-center gap-2">
              <div 
                className="h-3 w-3 rounded-full border" 
                style={{ backgroundColor: theme.accentColor || 'currentColor' }}
              />
              {theme.label}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
